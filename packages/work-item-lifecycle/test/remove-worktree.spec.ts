import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, type Layer as LayerType } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import {
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
import {
  KeymaxxerError,
  KeymaxxerService,
  type KeymaxxerServiceShape,
  type RunWithSecretsInput,
} from "@ready-for-agent/keymaxxer-service"
import {
  RemoveWorktreeCredentialError,
  RemoveWorktreeRemoteError,
  createWorktree,
  localCleanup,
  makeWorkItemId,
  removeWorktree,
  workItemBranchName,
  workItemWorktreePath,
} from "../src/index.js"
import { describe, expect, it, setDefaultTimeout } from "bun:test"

// Real git + worktree-remove shims under nx parallel CI load can exceed the
// default 5s (Directory-not-empty retry cases create a bare repo and worktree).
setDefaultTimeout(15_000)

const PlatformLayer = BunServices.layer

const stubKeymaxxer = (
  overrides: Partial<KeymaxxerServiceShape> = {},
): Layer.Layer<KeymaxxerService> =>
  Layer.succeed(KeymaxxerService, {
    initialize: Effect.void,
    hasSecret: () => Effect.succeed(true),
    findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
    findSecrets: () => Effect.succeed([]),
    addSecret: () => Effect.succeed(true),
    runWithSecrets: () =>
      Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" }),
    ...overrides,
  })

const stubGitLab = (
  overrides: Partial<GitLabServiceShape> = {},
): Layer.Layer<GitLabService> =>
  Layer.succeed(GitLabService, {
    verifyProject: (repository) => Effect.succeed(repository),
    getAuthenticatedUserLogin: () => Effect.succeed("operator"),
    listReadyIssues: () => Effect.succeed([]),
    hasCredentials: () => Effect.succeed(true),
    hasAmbientCredentials: () => Effect.succeed(true),
    getOpenPullRequestNumber: () => Effect.succeed(1),
    findOpenPullRequestNumber: () => Effect.succeed(null),
    createDraftPullRequest: () => Effect.succeed(1),
    updateOpenDraftPullRequestCopy: () => Effect.succeed(null),
    countOpenNonDraftPullRequests: () => Effect.succeed(0),
    getPullRequestCheckStatus: () =>
      Effect.succeed({
        _tag: "succeeded",
        terminalChecks: [],
        mergeability: "mergeable",
        baseRefName: "main",
        headPushedAt: null,
        headSha: null,
        createdAt: null,
        isDraft: null,
      }),
    getPrStatusCheckDiagnostics: () => Effect.succeed([]),
    markPullRequestReadyForReview: () => Effect.void,
    getPullRequestLifecycleStatus: () =>
      Effect.succeed({ _tag: "open" as const }),
    mergePullRequest: () => Effect.succeed({ _tag: "merged" as const }),
    ensureIssueCompletedWithSummary: () => Effect.void,
    closeOpenPullRequestsForBranch: () => Effect.void,
    deleteBranch: () => Effect.void,
    ...overrides,
  } satisfies GitLabServiceShape)

/**
 * FileSystem layer that fails residual `remove` for a sticky path so Local
 * cleanup's residual postcondition can be forced after retries.
 * - `noop`: pretends success while leaving the path (path recreated race).
 * - `throw`: fails like ENOTEMPTY/EBUSY while a concurrent writer holds the tree.
 */
const stickyResidualRemoveLayer = (
  stickyPath: string,
  attempts: { count: number },
  mode: "noop" | "throw" = "noop",
): Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem> =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const base = yield* FileSystem.FileSystem
      const normalizedSticky = stickyPath.replace(/[/\\]+$/, "")
      return {
        ...base,
        remove: (
          path: string,
          options?: { readonly recursive?: boolean; readonly force?: boolean },
        ) => {
          const normalized = path.replace(/[/\\]+$/, "")
          if (
            normalized === normalizedSticky ||
            normalized.startsWith(`${normalizedSticky}/`)
          ) {
            attempts.count += 1
            if (mode === "throw") {
              return Effect.fail(
                new Error(`EBUSY: directory busy: ${path}`),
              ) as ReturnType<typeof base.remove>
            }
            return Effect.void
          }
          return base.remove(path, options)
        },
      }
    }),
  )

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | LayerType.Layer.Success<typeof PlatformLayer>
    | LayerType.Layer.Success<typeof DbServiceLive>
    | KeymaxxerService
    | GitLabService
  >,
  keymaxxerLayer: Layer.Layer<KeymaxxerService> = stubKeymaxxer(),
  gitlabLayer: Layer.Layer<GitLabService> = stubGitLab(),
  fileSystemOverlay?: Layer.Layer<
    FileSystem.FileSystem,
    never,
    FileSystem.FileSystem
  >,
): Promise<A> => {
  const withServices = effect.pipe(
    Effect.provide(DbServiceLive),
    Effect.provide(DatabaseTest),
    Effect.provide(keymaxxerLayer),
    Effect.provide(gitlabLayer),
  )
  const withPlatform =
    fileSystemOverlay === undefined
      ? withServices.pipe(Effect.provide(PlatformLayer))
      : withServices.pipe(
          Effect.provide(fileSystemOverlay),
          Effect.provide(PlatformLayer),
        )
  return Effect.runPromise(withPlatform)
}

const git = async (cwd: string, args: ReadonlyArray<string>) => {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`,
    )
  }
  return stdout.trim()
}

const initBareRepository = async (root: string) => {
  const source = join(root, "source")
  const bare = join(root, "widgets.git")
  await mkdir(source, { recursive: true })
  await git(source, ["init", "-b", "main"])
  await git(source, ["config", "user.email", "test@example.com"])
  await git(source, ["config", "user.name", "Test"])
  await writeFile(join(source, "README.md"), "# widgets\n")
  await git(source, ["add", "README.md"])
  await git(source, ["commit", "--no-verify", "-m", "initial"])
  await git(root, ["clone", "--bare", source, bare])
  return bare
}

const realGitPath = async (): Promise<string> => {
  const proc = Bun.spawn(["sh", "-c", "command -v git"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  if (exitCode !== 0 || stdout.trim() === "") {
    throw new Error("could not resolve real git for PATH shim")
  }
  return stdout.trim()
}

/**
 * Install a `git` shim first on PATH that fails the first N
 * `worktree remove --force` calls with "Directory not empty", then delegates
 * to the real git. Returns restore + attempt counter helpers.
 *
 * The shim fails *before* invoking real Git, so registration remains present
 * and a second `worktree remove` is still a valid Git command.
 */
const installWorktreeRemoveFailShim = async (
  root: string,
  options: { readonly failTimes: number },
) => {
  const realGit = await realGitPath()
  const binDir = join(root, "git-shim-bin")
  const stateFile = join(root, "git-shim-remove-attempts")
  await mkdir(binDir, { recursive: true })
  await writeFile(stateFile, "0")
  const shimPath = join(binDir, "git")
  const shim = `#!/usr/bin/env bash
set -euo pipefail
REAL_GIT=${JSON.stringify(realGit)}
STATE=${JSON.stringify(stateFile)}
FAIL_TIMES=${String(options.failTimes)}
is_force_remove=0
prev=""
for arg in "$@"; do
  if [[ "$prev" == "worktree" && "$arg" == "remove" ]]; then
    is_force_remove=1
  fi
  if [[ "$arg" == "--force" && "$is_force_remove" -eq 1 ]]; then
    count=$(cat "$STATE")
    next=$((count + 1))
    echo "$next" > "$STATE"
    if [[ "$count" -lt "$FAIL_TIMES" ]]; then
      path="\${@: -1}"
      echo "error: failed to delete '$path': Directory not empty" >&2
      exit 255
    fi
    break
  fi
  prev="$arg"
done
exec "$REAL_GIT" "$@"
`
  await writeFile(shimPath, shim)
  await chmod(shimPath, 0o755)
  const previousPath = process.env.PATH ?? ""
  process.env.PATH = `${binDir}:${previousPath}`
  return {
    removeAttempts: async () =>
      Number.parseInt(await readFile(stateFile, "utf8"), 10),
    restore: () => {
      process.env.PATH = previousPath
    },
  }
}

/**
 * Model the production partial-removal race: Git unregisters the worktree
 * (and deletes its files), a concurrent writer leaves residual `.nx` content,
 * and Git then reports "Directory not empty". A second `worktree remove` is
 * invalid once registration is gone ("not a working tree").
 */
const installPartialWorktreeRemoveShim = async (root: string) => {
  const realGit = await realGitPath()
  const binDir = join(root, "git-shim-partial-bin")
  const stateFile = join(root, "git-shim-partial-remove-attempts")
  await mkdir(binDir, { recursive: true })
  await writeFile(stateFile, "0")
  const shimPath = join(binDir, "git")
  const shim = `#!/usr/bin/env bash
set -euo pipefail
REAL_GIT=${JSON.stringify(realGit)}
STATE=${JSON.stringify(stateFile)}
is_force_remove=0
prev=""
for arg in "$@"; do
  if [[ "$prev" == "worktree" && "$arg" == "remove" ]]; then
    is_force_remove=1
  fi
  if [[ "$arg" == "--force" && "$is_force_remove" -eq 1 ]]; then
    count=$(cat "$STATE")
    next=$((count + 1))
    echo "$next" > "$STATE"
    path="\${@: -1}"
    if [[ "$count" -eq 0 ]]; then
      # Real Git removes registration (and the tree); then leave residual files.
      "$REAL_GIT" "$@"
      mkdir -p "$path/.nx/workspace-data"
      echo "residual" > "$path/.nx/workspace-data/nx_files.nxt"
      echo "error: failed to delete '$path': Directory not empty" >&2
      exit 255
    fi
    # Further force-removes must not be required; delegate so a mistaken
    # retry surfaces as "not a working tree".
    break
  fi
  prev="$arg"
done
exec "$REAL_GIT" "$@"
`
  await writeFile(shimPath, shim)
  await chmod(shimPath, 0o755)
  const previousPath = process.env.PATH ?? ""
  process.env.PATH = `${binDir}:${previousPath}`
  return {
    removeAttempts: async () =>
      Number.parseInt(await readFile(stateFile, "utf8"), 10),
    restore: () => {
      process.env.PATH = previousPath
    },
  }
}

const baseContext = (input: {
  readonly workItemId: string
  readonly repositoryId: string
  readonly issueNumber?: number
}) =>
  ({
    workItemId: input.workItemId,
    repositoryId: input.repositoryId,
    issueNumber: input.issueNumber ?? 42,
    issueTitle: null,
    agentBackend: "opencode",
    model: "opencode/test",
    thinkingLevel: "low",
    reviewModel: "opencode/test",
    reviewThinkingLevel: "low",
    worktreePath: null,
    startingCommitOid: null,
    completionSummary: null,
    publicationTitle: null,
    publicationBody: null,
    sessionId: null,
  }) as const

describe("removeWorktree", () => {
  it("cleans up GitLab remote MRs and branch via GitLabService", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-gitlab-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()
      let keymaxxerCalls = 0
      const closedBranches: string[] = []
      const deletedBranches: string[] = []

      const { path, branch } = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "gitlab",
            forgeHost: "git.drupalcode.org",
            projectPath: "project/widgets",
            localPath: bare,
            isBare: true,
          })
          const context = {
            workItemId,
            repositoryId: repository.id,
            issueNumber: 42,
            issueTitle: null,
            agentBackend: "opencode",
            model: "opencode/test",
            thinkingLevel: "low",
            reviewModel: "opencode/test",
            reviewThinkingLevel: "low",
            worktreePath: null,
            startingCommitOid: null,
            completionSummary: null,
            publicationTitle: null,
            publicationBody: null,
            sessionId: null,
          } as const
          const created = yield* createWorktree(context)
          yield* removeWorktree({
            ...context,
            worktreePath: created.worktreePath,
          })
          return {
            path: created.worktreePath,
            branch: workItemBranchName({
              projectPath: "project/widgets",
              issueNumber: 42,
              workItemId,
            }),
          }
        }),
        stubKeymaxxer({
          findSecret: () => {
            keymaxxerCalls += 1
            return Effect.succeed("GITHUB_TOKEN_PROJECT_WIDGETS")
          },
          runWithSecrets: () => {
            keymaxxerCalls += 1
            return Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" })
          },
        }),
        stubGitLab({
          closeOpenPullRequestsForBranch: (_repository, headRefName) =>
            Effect.sync(() => {
              closedBranches.push(headRefName)
            }),
          deleteBranch: (_repository, branchName) =>
            Effect.sync(() => {
              deletedBranches.push(branchName)
            }),
        }),
      )

      expect(await Bun.file(join(path, "README.md")).exists()).toBe(false)
      expect(await git(bare, ["branch", "--list", branch])).toBe("")
      expect(closedBranches).toEqual([branch])
      expect(deletedBranches).toEqual([branch])
      expect(keymaxxerCalls).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("locally removes the worktree and branch without remote cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-local-cleanup-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()
      let remoteCalls = 0

      const { path, branch } = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })
          const context = {
            workItemId,
            repositoryId: repository.id,
            issueNumber: 42,
            issueTitle: null,
            agentBackend: "opencode",
            model: "opencode/test",
            thinkingLevel: "low",
            reviewModel: "opencode/test",
            reviewThinkingLevel: "low",
            worktreePath: null,
            startingCommitOid: null,
            completionSummary: null,

            publicationTitle: null,

            publicationBody: null,
            sessionId: null,
          } as const

          const created = yield* createWorktree(context)
          const path = created.worktreePath
          yield* localCleanup({ ...context, worktreePath: path })
          return {
            path,
            branch: workItemBranchName({
              forge: "github",
              forgeHost: "github.com",
              projectPath: "acme/widgets",
              issueNumber: 42,
              workItemId,
            }),
          }
        }),
        stubKeymaxxer({
          runWithSecrets: () => {
            remoteCalls += 1
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
          },
        }),
      )

      expect(await Bun.file(join(path, "README.md")).exists()).toBe(false)
      expect(await git(bare, ["branch", "--list", branch])).toBe("")
      expect(remoteCalls).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("removes the worktree directory and deletes the Work Item branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const { path, branch } = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })

          const context = {
            workItemId,
            repositoryId: repository.id,
            issueNumber: 42,
            issueTitle: null,
            agentBackend: "opencode",
            model: "opencode/test",
            thinkingLevel: "low",
            reviewModel: "opencode/test",
            reviewThinkingLevel: "low",
            worktreePath: null,
            startingCommitOid: null,
            completionSummary: null,

            publicationTitle: null,

            publicationBody: null,
            sessionId: null,
          } as const

          const created = yield* createWorktree(context)
          yield* removeWorktree(context)
          return {
            path: created.worktreePath,
            branch: workItemBranchName({
              forge: "github",
              forgeHost: "github.com",
              projectPath: "acme/widgets",
              issueNumber: 42,
              workItemId,
            }),
          }
        }),
      )

      expect(await Bun.file(join(path, "README.md")).exists()).toBe(false)

      const branches = await git(bare, ["branch", "--list", branch])
      expect(branches).toBe("")

      const worktrees = await git(bare, ["worktree", "list", "--porcelain"])
      expect(worktrees.includes(path)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("is a no-op when the worktree and branch are already gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-absent-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })

          yield* removeWorktree({
            workItemId,
            repositoryId: repository.id,
            issueNumber: 42,
            issueTitle: null,
            agentBackend: "opencode",
            model: "opencode/test",
            thinkingLevel: "low",
            reviewModel: "opencode/test",
            reviewThinkingLevel: "low",
            worktreePath: null,
            startingCommitOid: null,
            completionSummary: null,

            publicationTitle: null,

            publicationBody: null,
            sessionId: null,
          })
        }),
      )

      const planned = workItemWorktreePath({
        localPath: bare,
        isBare: true,
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
        issueNumber: 42,
        workItemId,
      })
      expect(await Bun.file(join(planned, "README.md")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("removes a worktree when only the path is known from context", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-path-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const path = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })

          const context = {
            workItemId,
            repositoryId: repository.id,
            issueNumber: 42,
            issueTitle: null,
            agentBackend: "opencode",
            model: "opencode/test",
            thinkingLevel: "low",
            reviewModel: "opencode/test",
            reviewThinkingLevel: "low",
            worktreePath: null,
            startingCommitOid: null,
            completionSummary: null,

            publicationTitle: null,

            publicationBody: null,
            sessionId: null,
          } as const

          const created = yield* createWorktree(context)
          yield* removeWorktree({
            ...context,
            worktreePath: created.worktreePath,
          })
          return created.worktreePath
        }),
      )

      expect(await Bun.file(join(path, "README.md")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reports Git's diagnostic when a locked worktree cannot be removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-locked-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const error = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })
          const context = baseContext({
            workItemId,
            repositoryId: repository.id,
          })

          const created = yield* createWorktree(context)
          yield* Effect.promise(() =>
            git(bare, ["worktree", "lock", created.worktreePath]),
          )
          return yield* localCleanup(context).pipe(Effect.flip)
        }),
      )

      expect(error._tag).toBe("GitCommandError")
      expect(error.message).toContain("locked working tree")
      if (error._tag === "GitCommandError") {
        expect(error.stderr).toContain("locked working tree")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("retries worktree remove once after Directory not empty and succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-retry-ok-"))
    const shim = await installWorktreeRemoveFailShim(root, { failTimes: 1 })
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const { path, branch } = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })
          const context = baseContext({
            workItemId,
            repositoryId: repository.id,
          })
          const created = yield* createWorktree(context)
          yield* localCleanup({
            ...context,
            worktreePath: created.worktreePath,
          })
          return {
            path: created.worktreePath,
            branch: workItemBranchName({
              projectPath: "acme/widgets",
              issueNumber: 42,
              workItemId,
            }),
          }
        }),
      )

      expect(await Bun.file(join(path, "README.md")).exists()).toBe(false)
      expect(await git(bare, ["branch", "--list", branch])).toBe("")
      // First remove failed (shim), second remove succeeded (real git).
      expect(await shim.removeAttempts()).toBe(2)
    } finally {
      shim.restore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails Local cleanup when Directory not empty persists after one retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-retry-fail-"))
    const shim = await installWorktreeRemoveFailShim(root, { failTimes: 2 })
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const error = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })
          const context = baseContext({
            workItemId,
            repositoryId: repository.id,
          })
          const created = yield* createWorktree(context)
          return yield* localCleanup({
            ...context,
            worktreePath: created.worktreePath,
          }).pipe(Effect.flip)
        }),
      )

      expect(error._tag).toBe("GitCommandError")
      expect(error.message.toLowerCase()).toContain("directory not empty")
      if (error._tag === "GitCommandError") {
        expect(error.stderr.toLowerCase()).toContain("directory not empty")
      }
      // Exactly one automatic retry: two force-remove attempts total.
      expect(await shim.removeAttempts()).toBe(2)
    } finally {
      shim.restore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("recovers when Git unregisters the worktree but leaves residual .nx files", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-partial-"))
    const shim = await installPartialWorktreeRemoveShim(root)
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const { path, branch } = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })
          const context = baseContext({
            workItemId,
            repositoryId: repository.id,
          })
          const created = yield* createWorktree(context)
          yield* localCleanup({
            ...context,
            worktreePath: created.worktreePath,
          })
          return {
            path: created.worktreePath,
            branch: workItemBranchName({
              projectPath: "acme/widgets",
              issueNumber: 42,
              workItemId,
            }),
          }
        }),
      )

      // Residual directory fully removed in the same Step Run.
      expect(
        await Bun.file(join(path, ".nx/workspace-data/nx_files.nxt")).exists(),
      ).toBe(false)
      expect(await Bun.file(path).exists()).toBe(false)
      expect(await git(bare, ["branch", "--list", branch])).toBe("")
      const worktrees = await git(bare, ["worktree", "list", "--porcelain"])
      expect(worktrees.includes(path)).toBe(false)
      // Must not re-issue worktree remove after registration is gone.
      expect(await shim.removeAttempts()).toBe(1)
    } finally {
      shim.restore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails Local cleanup when residual directory survives recursive remove retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-residual-stuck-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()
      const residualPath = workItemWorktreePath({
        localPath: bare,
        isBare: true,
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
        issueNumber: 42,
        workItemId,
      })
      await mkdir(join(residualPath, ".nx/workspace-data"), { recursive: true })
      await writeFile(
        join(residualPath, ".nx/workspace-data/nx_files.nxt"),
        "sticky\n",
      )
      const attempts = { count: 0 }

      const error = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })
          return yield* localCleanup(
            baseContext({
              workItemId,
              repositoryId: repository.id,
            }),
          ).pipe(Effect.flip)
        }),
        stubKeymaxxer(),
        stubGitLab(),
        stickyResidualRemoveLayer(residualPath, attempts),
      )

      expect(error._tag).toBe("GitCommandError")
      expect(error.message).toContain("Residual worktree directory remains")
      if (error._tag === "GitCommandError") {
        expect(error.command).toBe("rm")
        expect(error.args).toEqual(["-rf", residualPath])
        expect(error.stderr).toContain(
          "path still exists after recursive remove",
        )
      }
      // First residual remove + one automatic retry.
      expect(attempts.count).toBe(2)
      // Residual intentionally left for the postcondition failure.
      expect(
        await Bun.file(
          join(residualPath, ".nx/workspace-data/nx_files.nxt"),
        ).exists(),
      ).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("retries residual remove when the first filesystem remove throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-residual-throw-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()
      const residualPath = workItemWorktreePath({
        localPath: bare,
        isBare: true,
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
        issueNumber: 42,
        workItemId,
      })
      await mkdir(join(residualPath, ".nx/workspace-data"), { recursive: true })
      await writeFile(
        join(residualPath, ".nx/workspace-data/nx_files.nxt"),
        "busy\n",
      )
      const attempts = { count: 0 }

      const error = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })
          return yield* localCleanup(
            baseContext({
              workItemId,
              repositoryId: repository.id,
            }),
          ).pipe(Effect.flip)
        }),
        stubKeymaxxer(),
        stubGitLab(),
        stickyResidualRemoveLayer(residualPath, attempts, "throw"),
      )

      expect(error._tag).toBe("GitCommandError")
      expect(error.message).toContain("Residual worktree directory remains")
      if (error._tag === "GitCommandError") {
        expect(error.command).toBe("rm")
        expect(error.stderr).toContain(
          "path still exists after recursive remove",
        )
      }
      // First remove throws, sleep, second remove throws, then residual fails.
      expect(attempts.count).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("closes an open remote PR for the Work Item branch and drops the remote branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-remote-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()
      const branch = workItemBranchName({
        forge: "github",
        forgeHost: "github.com",
        projectPath: "acme/widgets",
        issueNumber: 42,
        workItemId,
      })
      const commands: string[] = []

      await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })

          const context = {
            workItemId,
            repositoryId: repository.id,
            issueNumber: 42,
            issueTitle: null,
            agentBackend: "opencode",
            model: "opencode/test",
            thinkingLevel: "low",
            reviewModel: "opencode/test",
            reviewThinkingLevel: "low",
            worktreePath: null,
            startingCommitOid: null,
            completionSummary: null,

            publicationTitle: null,

            publicationBody: null,
            sessionId: null,
          } as const

          yield* createWorktree(context)
          yield* removeWorktree(context)
        }),
        stubKeymaxxer({
          findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
          runWithSecrets: (input: RunWithSecretsInput) => {
            commands.push(input.command)
            if (input.command.includes("'gh' 'pr' 'list'")) {
              return Effect.succeed({
                exitCode: 0,
                stdout: '[{"number":77}]',
                stderr: "",
              })
            }
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
          },
        }),
      )

      expect(commands.length).toBe(3)
      expect(commands[0]).toContain('GH_TOKEN="$GITHUB_TOKEN_ACME_WIDGETS"')
      expect(commands[0]).toContain('GITHUB_TOKEN="$GITHUB_TOKEN_ACME_WIDGETS"')
      expect(commands[0]).toContain("'gh' 'pr' 'list'")
      expect(commands[0]).toContain(branch)
      expect(commands[0]).toContain("acme/widgets")
      expect(commands[1]).toContain("'gh' 'pr' 'close' '77'")
      expect(commands[1]).toContain("acme/widgets")
      expect(commands[2]).toContain("'gh' 'api' '-X' 'DELETE'")
      expect(commands[2]).toContain(`git/refs/heads/${branch}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("succeeds when no open PR or remote branch exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-remote-absent-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()
      let listCalls = 0
      let deleteCalls = 0

      await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })

          yield* removeWorktree({
            workItemId,
            repositoryId: repository.id,
            issueNumber: 42,
            issueTitle: null,
            agentBackend: "opencode",
            model: "opencode/test",
            thinkingLevel: "low",
            reviewModel: "opencode/test",
            reviewThinkingLevel: "low",
            worktreePath: null,
            startingCommitOid: null,
            completionSummary: null,

            publicationTitle: null,

            publicationBody: null,
            sessionId: null,
          })
        }),
        stubKeymaxxer({
          runWithSecrets: (input) => {
            if (input.command.includes("'gh' 'pr' 'list'")) {
              listCalls += 1
              return Effect.succeed({
                exitCode: 0,
                stdout: "[]",
                stderr: "",
              })
            }
            if (input.command.includes("git/refs/heads/")) {
              deleteCalls += 1
              return Effect.succeed({
                exitCode: 1,
                stdout: "",
                stderr: "Not Found",
              })
            }
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
          },
        }),
      )

      expect(listCalls).toBe(1)
      expect(deleteCalls).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("fails when no GitHub credential is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-no-cred-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const error = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })

          return yield* removeWorktree({
            workItemId,
            repositoryId: repository.id,
            issueNumber: 42,
            issueTitle: null,
            agentBackend: "opencode",
            model: "opencode/test",
            thinkingLevel: "low",
            reviewModel: "opencode/test",
            reviewThinkingLevel: "low",
            worktreePath: null,
            startingCommitOid: null,
            completionSummary: null,

            publicationTitle: null,

            publicationBody: null,
            sessionId: null,
          }).pipe(Effect.flip)
        }),
        stubKeymaxxer({ findSecret: () => Effect.succeed(null) }),
      )

      expect(error).toBeInstanceOf(RemoveWorktreeCredentialError)
      expect((error as RemoveWorktreeCredentialError).message).toContain(
        "No GitHub credential is configured for acme/widgets",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("maps Keymaxxer remote command failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfa-rm-wt-remote-fail-"))
    try {
      const bare = await initBareRepository(root)
      const workItemId = makeWorkItemId()

      const error = await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            forge: "github",
            forgeHost: "github.com",
            projectPath: "acme/widgets",
            localPath: bare,
            isBare: true,
          })

          return yield* removeWorktree({
            workItemId,
            repositoryId: repository.id,
            issueNumber: 42,
            issueTitle: null,
            agentBackend: "opencode",
            model: "opencode/test",
            thinkingLevel: "low",
            reviewModel: "opencode/test",
            reviewThinkingLevel: "low",
            worktreePath: null,
            startingCommitOid: null,
            completionSummary: null,

            publicationTitle: null,

            publicationBody: null,
            sessionId: null,
          }).pipe(Effect.flip)
        }),
        stubKeymaxxer({
          runWithSecrets: () =>
            Effect.fail(
              new KeymaxxerError({
                operation: "runWithSecrets",
                message: "process failed",
              }),
            ),
        }),
      )

      expect(error).toBeInstanceOf(RemoveWorktreeRemoteError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
