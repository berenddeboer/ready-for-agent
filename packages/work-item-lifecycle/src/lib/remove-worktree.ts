import { Duration, Effect, FileSystem, Path } from "effect"
import { DbService, type RepositoryRecord } from "@ready-for-agent/db-service"
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
    const account = `${repository.githubOwner}/${repository.githubRepo}`
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
    const repo = `${input.repository.githubOwner}/${input.repository.githubRepo}`
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
    const repo = `${input.repository.githubOwner}/${input.repository.githubRepo}`
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

const removeRemoteArtifacts = (input: {
  readonly repository: RepositoryRecord
  readonly branchName: string
}) =>
  Effect.gen(function* () {
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
      githubOwner: repository.githubOwner,
      githubRepo: repository.githubRepo,
      githubIssueNumber: context.githubIssueNumber,
      workItemId: context.workItemId,
    })

    const plannedPath = workItemWorktreePath({
      localPath: repository.localPath,
      isBare: repository.isBare,
      githubOwner: repository.githubOwner,
      githubRepo: repository.githubRepo,
      githubIssueNumber: context.githubIssueNumber,
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
        yield* runGit(gitRepository, [
          "worktree",
          "remove",
          "--force",
          worktreePath,
        ])
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
 * Inverse of createWorktree: remove local artifacts, close any open remote PR,
 * and drop the remote branch when present. Missing artifacts are success
 * (idempotent). Missing GitHub credential fails.
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
