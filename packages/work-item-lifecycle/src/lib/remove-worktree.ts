import { Duration, Effect, FileSystem, Path } from "effect"
import { DbService, type RepositoryRecord } from "@ready-for-agent/db-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import {
  CreateWorktreeRepositoryNotFoundError,
  type GitCommandError,
} from "./create-worktree-errors.js"
import { type GitRepository, gitExitCode, runGit } from "./git.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  RemoveWorktreeCredentialError,
  RemoveWorktreeRemoteError,
} from "./remove-worktree-errors.js"
import { workItemBranchName, workItemWorktreePath } from "./worktree-names.js"

const REMOTE_CLEANUP_TIMEOUT = Duration.seconds(60)

/** Brief pause before a single automatic retry of a transient worktree delete. */
const WORKTREE_REMOVE_RETRY_DELAY = Duration.seconds(1)

/**
 * Git sometimes fails `worktree remove --force` with exit 255 / "Directory not
 * empty" while handles or delayed unlinks still hold the tree. One automatic
 * retry usually succeeds; other failures (e.g. locked working tree) are not
 * retried.
 */
const isDirectoryNotEmptyError = (error: GitCommandError): boolean => {
  const haystack = `${error.message}\n${error.stderr}`.toLowerCase()
  return haystack.includes("directory not empty")
}

const resolveRepository = (repositoryId: string) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(({ id }) => id === repositoryId)
    if (repository === undefined) {
      return yield* new CreateWorktreeRepositoryNotFoundError({ repositoryId })
    }
    return repository
  })

const asGitRepository = (repository: RepositoryRecord): GitRepository => ({
  localPath: repository.localPath,
  isBare: repository.isBare,
})

const worktreeListContains = (
  repository: GitRepository,
  worktreePath: string,
) =>
  runGit(repository, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map((output) => {
      const normalized = worktreePath.replace(/[/\\]+$/, "")
      return output
        .split("\n")
        .some(
          (line) =>
            line.startsWith("worktree ") &&
            line.slice("worktree ".length).replace(/[/\\]+$/, "") ===
              normalized,
        )
    }),
  )

const pathExists = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(path)
  })

const removeDirectoryIfPresent = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(path)
    if (exists) {
      yield* fs.remove(path, { recursive: true, force: true })
    }
  })

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

const credentialedCommand = (
  tokenName: string | null,
  parts: ReadonlyArray<string>,
) =>
  [
    ...(tokenName === null
      ? []
      : [`GH_TOKEN="$${tokenName}"`, `GITHUB_TOKEN="$${tokenName}"`]),
    ...parts.map(shellQuote),
  ].join(" ")

const resolveGithubCredential = (repository: RepositoryRecord) =>
  Effect.gen(function* () {
    const keymaxxer = yield* KeymaxxerService
    if (keymaxxer.enabled === false) return null
    const account = `${repository.projectPath}`
    const tokenName = yield* keymaxxer
      .findSecret({
        provider: "github",
        account,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RemoveWorktreeCredentialError({
              repositoryId: repository.id,
              message: "Failed to resolve the repository GitHub credential",
              cause,
            }),
        ),
      )
    if (tokenName === null) {
      return yield* new RemoveWorktreeCredentialError({
        repositoryId: repository.id,
        message: `No GitHub credential is configured for ${account}`,
      })
    }
    return tokenName
  })

const runRemoteCommand = (input: {
  readonly tokenName: string | null
  readonly cwd: string
  readonly parts: ReadonlyArray<string>
  readonly branchName: string
  readonly allowNonZero?: boolean
}) =>
  Effect.gen(function* () {
    const keymaxxer = yield* KeymaxxerService
    const result = yield* keymaxxer
      .runWithSecrets({
        command: credentialedCommand(input.tokenName, input.parts),
        cwd: input.cwd,
        secrets: input.tokenName === null ? [] : [input.tokenName],
        timeoutMs: Duration.toMillis(REMOTE_CLEANUP_TIMEOUT),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new RemoveWorktreeRemoteError({
              message: "Failed to clean up remote PR or branch",
              branchName: input.branchName,
              cause,
            }),
        ),
      )
    if (result.exitCode !== 0 && input.allowNonZero !== true) {
      return yield* new RemoveWorktreeRemoteError({
        message: "Failed to clean up remote PR or branch",
        branchName: input.branchName,
      })
    }
    return result
  })

const closeOpenPullRequests = (input: {
  readonly repository: RepositoryRecord
  readonly branchName: string
  readonly tokenName: string | null
  readonly cwd: string
}) =>
  Effect.gen(function* () {
    const repo = `${input.repository.projectPath}`
    const listed = yield* runRemoteCommand({
      tokenName: input.tokenName,
      cwd: input.cwd,
      branchName: input.branchName,
      parts: [
        "gh",
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        input.branchName,
        "--state",
        "open",
        "--json",
        "number",
      ],
    })

    const pullRequests = yield* Effect.try({
      try: () =>
        JSON.parse(listed.stdout.trim() || "[]") as ReadonlyArray<{
          readonly number: number
        }>,
      catch: (cause) =>
        new RemoveWorktreeRemoteError({
          message: "Failed to parse open pull request list for remote cleanup",
          branchName: input.branchName,
          cause,
        }),
    })

    for (const pullRequest of pullRequests) {
      yield* runRemoteCommand({
        tokenName: input.tokenName,
        cwd: input.cwd,
        branchName: input.branchName,
        parts: [
          "gh",
          "pr",
          "close",
          String(pullRequest.number),
          "--repo",
          repo,
        ],
      })
    }
  })

const deleteRemoteBranch = (input: {
  readonly repository: RepositoryRecord
  readonly branchName: string
  readonly tokenName: string | null
  readonly cwd: string
}) =>
  Effect.gen(function* () {
    const repo = `${input.repository.projectPath}`
    // Missing remote branch is success (idempotent); other failures fail cleanup.
    const result = yield* runRemoteCommand({
      tokenName: input.tokenName,
      cwd: input.cwd,
      branchName: input.branchName,
      allowNonZero: true,
      parts: [
        "gh",
        "api",
        "-X",
        "DELETE",
        `repos/${repo}/git/refs/heads/${input.branchName}`,
      ],
    })
    if (result.exitCode === 0) {
      return
    }
    const stderr = result.stderr.toLowerCase()
    const stdout = result.stdout.toLowerCase()
    if (
      result.exitCode === 1 &&
      (stderr.includes("not found") ||
        stdout.includes("not found") ||
        stderr.includes("reference does not exist") ||
        stdout.includes("reference does not exist"))
    ) {
      return
    }
    return yield* new RemoveWorktreeRemoteError({
      message: "Failed to delete remote Work Item branch",
      branchName: input.branchName,
    })
  })

const removeGitLabRemoteArtifacts = (input: {
  readonly repository: RepositoryRecord
  readonly branchName: string
}) =>
  Effect.gen(function* () {
    const gitlab = yield* GitLabService
    const forgeRepository = {
      forge: input.repository.forge,
      forgeHost: input.repository.forgeHost,
      projectPath: input.repository.projectPath,
    }
    yield* gitlab
      .closeOpenPullRequestsForBranch(forgeRepository, input.branchName)
      .pipe(
        Effect.mapError(
          (cause) =>
            new RemoveWorktreeRemoteError({
              message: "Failed to close open GitLab merge requests for cleanup",
              branchName: input.branchName,
              cause,
            }),
        ),
      )
    yield* gitlab.deleteBranch(forgeRepository, input.branchName).pipe(
      Effect.mapError(
        (cause) =>
          new RemoveWorktreeRemoteError({
            message: "Failed to delete remote GitLab Work Item branch",
            branchName: input.branchName,
            cause,
          }),
      ),
    )
  })

const removeRemoteArtifacts = (input: {
  readonly repository: RepositoryRecord
  readonly branchName: string
}) =>
  Effect.gen(function* () {
    if (input.repository.forge === "gitlab") {
      return yield* removeGitLabRemoteArtifacts(input)
    }
    const tokenName = yield* resolveGithubCredential(input.repository)
    const cwd = input.repository.localPath
    yield* closeOpenPullRequests({
      repository: input.repository,
      branchName: input.branchName,
      tokenName,
      cwd,
    })
    yield* deleteRemoteBranch({
      repository: input.repository,
      branchName: input.branchName,
      tokenName,
      cwd,
    })
  })

const removeLocalArtifacts = (
  repository: RepositoryRecord,
  context: LifecycleStepContext,
  options: { readonly tmpDir?: string } = {},
) =>
  Effect.gen(function* () {
    const pathService = yield* Path.Path
    const gitRepository = asGitRepository(repository)

    const branchName = workItemBranchName({
      projectPath: repository.projectPath,
      issueNumber: context.issueNumber,
      workItemId: context.workItemId,
    })

    const plannedPath = workItemWorktreePath({
      localPath: repository.localPath,
      isBare: repository.isBare,
      projectPath: repository.projectPath,
      issueNumber: context.issueNumber,
      workItemId: context.workItemId,
      tmpDir: options.tmpDir,
    })

    const candidates = new Set<string>()
    candidates.add(pathService.resolve(plannedPath))
    if (context.worktreePath !== null && context.worktreePath.trim() !== "") {
      candidates.add(pathService.resolve(context.worktreePath))
    }

    for (const worktreePath of candidates) {
      const listed = yield* worktreeListContains(gitRepository, worktreePath)
      if (listed) {
        const forceRemoveOnce = runGit(gitRepository, [
          "worktree",
          "remove",
          "--force",
          worktreePath,
        ]).pipe(
          Effect.catchTag("GitCommandError", (error) =>
            Effect.gen(function* () {
              // Git can remove the worktree before reporting a late cleanup error.
              const [stillListed, stillPresent] = yield* Effect.all([
                worktreeListContains(gitRepository, worktreePath),
                pathExists(worktreePath),
              ])
              if (!stillListed && !stillPresent) return
              return yield* error
            }),
          ),
        )

        yield* forceRemoveOnce.pipe(
          Effect.catchTag("GitCommandError", (error) =>
            Effect.gen(function* () {
              // Transient "Directory not empty" often clears after a short wait;
              // retry the git remove once before failing Local cleanup.
              if (!isDirectoryNotEmptyError(error)) {
                return yield* error
              }
              yield* Effect.sleep(WORKTREE_REMOVE_RETRY_DELAY)
              return yield* forceRemoveOnce
            }),
          ),
        )
      }

      const stillPresent = yield* pathExists(worktreePath)
      if (stillPresent) {
        yield* removeDirectoryIfPresent(worktreePath)
        yield* runGit(gitRepository, ["worktree", "prune"])
      }
    }

    const hasBranch =
      (yield* gitExitCode(gitRepository, [
        "show-ref",
        "--verify",
        `refs/heads/${branchName}`,
      ])) === 0

    if (hasBranch) {
      yield* runGit(gitRepository, ["branch", "-D", branchName])
    }

    return branchName
  })

/**
 * Remove only the local worktree and Work Item branch. Missing artifacts are
 * success so a failed Lifecycle Step can be retried safely.
 */
export const localCleanup = (
  context: LifecycleStepContext,
  options: { readonly tmpDir?: string } = {},
) =>
  Effect.gen(function* () {
    const repository = yield* resolveRepository(context.repositoryId)
    yield* removeLocalArtifacts(repository, context, options)
  })

/**
 * Inverse of createWorktree: remove local artifacts, close any open remote
 * PR/MR, and drop the remote branch when present. Missing artifacts are
 * success (idempotent). Missing Forge credential fails for GitHub Keymaxxer
 * paths; GitLab cleanup uses the ambient GitLab service.
 */
export const removeWorktree = (
  context: LifecycleStepContext,
  options: { readonly tmpDir?: string } = {},
) =>
  Effect.gen(function* () {
    const repository = yield* resolveRepository(context.repositoryId)
    const branchName = yield* removeLocalArtifacts(repository, context, options)

    yield* removeRemoteArtifacts({ repository, branchName })
  })

export type RemoveWorktreeError =
  | CreateWorktreeRepositoryNotFoundError
  | GitCommandError
  | RemoveWorktreeCredentialError
  | RemoveWorktreeRemoteError
