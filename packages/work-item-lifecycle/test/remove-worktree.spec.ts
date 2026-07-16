import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, type Layer as LayerType } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
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
import { describe, expect, it } from "bun:test"

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
    removeSecret: () => Effect.succeed(true),
    runWithSecrets: () =>
      Effect.succeed({ exitCode: 0, stdout: "[]", stderr: "" }),
    ...overrides,
  })

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | LayerType.Layer.Success<typeof PlatformLayer>
    | LayerType.Layer.Success<typeof DbServiceLive>
    | KeymaxxerService
  >,
  keymaxxerLayer: Layer.Layer<KeymaxxerService> = stubKeymaxxer(),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(DbServiceLive),
      Effect.provide(DatabaseTest),
      Effect.provide(keymaxxerLayer),
      Effect.provide(PlatformLayer),
    ),
  )

const git = async (cwd: string, args: ReadonlyArray<string>) => {
  const proc = Bun.spawn(["git", ...args], {
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
  await git(source, ["commit", "-m", "initial"])
  await git(root, ["clone", "--bare", source, bare])
  return bare
}

describe("removeWorktree", () => {
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
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })
          const context = {
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            sessionId: null,
          } as const

          const path = yield* createWorktree(context)
          yield* localCleanup({ ...context, worktreePath: path })
          return {
            path,
            branch: workItemBranchName({
              githubOwner: "acme",
              githubRepo: "widgets",
              githubIssueNumber: 42,
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
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          const context = {
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            sessionId: null,
          } as const

          const created = yield* createWorktree(context)
          yield* removeWorktree(context)
          return {
            path: created,
            branch: workItemBranchName({
              githubOwner: "acme",
              githubRepo: "widgets",
              githubIssueNumber: 42,
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
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          yield* removeWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            sessionId: null,
          })
        }),
      )

      const planned = workItemWorktreePath({
        localPath: bare,
        isBare: true,
        githubOwner: "acme",
        githubRepo: "widgets",
        githubIssueNumber: 42,
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
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          const context = {
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
            sessionId: null,
          } as const

          const created = yield* createWorktree(context)
          yield* removeWorktree({
            ...context,
            worktreePath: created,
          })
          return created
        }),
      )

      expect(await Bun.file(join(path, "README.md")).exists()).toBe(false)
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
        githubOwner: "acme",
        githubRepo: "widgets",
        githubIssueNumber: 42,
        workItemId,
      })
      const commands: string[] = []

      await run(
        Effect.gen(function* () {
          const db = yield* DbService
          const repository = yield* db.addRepository({
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          const context = {
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
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
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          yield* removeWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
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
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          return yield* removeWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
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
            githubOwner: "acme",
            githubRepo: "widgets",
            localPath: bare,
            isBare: true,
          })

          return yield* removeWorktree({
            workItemId,
            repositoryId: repository.id,
            githubIssueNumber: 42,
            model: "opencode/test",
            variant: "low",
            reviewModel: "opencode/test",
            reviewVariant: "low",
            worktreePath: null,
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
