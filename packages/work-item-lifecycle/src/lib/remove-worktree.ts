import { Duration, Effect, FileSystem, Path } from "effect"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService, type RepositoryRecord } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import {
  CreateWorktreeRepositoryNotFoundError,
  GitCommandError,
} from "./create-worktree-errors.js"
import { type GitRepository, gitExitCode, runGit } from "./git.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { RemoveWorktreeRemoteError } from "./remove-worktree-errors.js"
import { workItemBranchName, workItemWorktreePath } from "./worktree-names.js"

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

/**
 * Remove an unregistered residual worktree directory with one automatic retry.
 * Concurrent writers (e.g. Nx) may cause the first `fs.remove` to throw
 * (ENOTEMPTY/EBUSY) or to succeed while immediately recreating files; either
 * case gets a brief wait and a second attempt before the caller postcondition.
 */
const removeResidualDirectoryWithRetry = (path: string) =>
  Effect.gen(function* () {
    yield* removeDirectoryIfPresent(path).pipe(Effect.ignore)
    if (!(yield* pathExists(path))) return
    yield* Effect.sleep(WORKTREE_REMOVE_RETRY_DELAY)
    yield* removeDirectoryIfPresent(path).pipe(Effect.ignore)
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

const removeGitHubRemoteArtifacts = (input: {
  readonly repository: RepositoryRecord
  readonly branchName: string
}) =>
  Effect.gen(function* () {
    const github = yield* GitHubService
    const forgeRepository = {
      forge: input.repository.forge,
      forgeHost: input.repository.forgeHost,
      projectPath: input.repository.projectPath,
    }
    // This is deliberately one service operation. Ambient and Keymaxxer
    // adapters therefore retain their coordinator permit across list, every
    // sequential close, and the final branch delete.
    yield* github.closeOpenPullRequestsAndDeleteBranch(
      forgeRepository,
      input.branchName,
    )
  })

const removeAzureDevOpsRemoteArtifacts = (input: {
  readonly repository: RepositoryRecord
  readonly branchName: string
}) =>
  Effect.gen(function* () {
    const azureDevOps = yield* AzureDevOpsService
    const forgeRepository = {
      forge: input.repository.forge,
      forgeHost: input.repository.forgeHost,
      projectPath: input.repository.projectPath,
    }
    yield* azureDevOps
      .closeOpenPullRequestsForBranch(forgeRepository, input.branchName)
      .pipe(
        Effect.mapError(
          (cause) =>
            new RemoveWorktreeRemoteError({
              message:
                "Failed to close open Azure DevOps pull requests for cleanup",
              branchName: input.branchName,
              cause,
            }),
        ),
      )
    yield* azureDevOps.deleteBranch(forgeRepository, input.branchName).pipe(
      Effect.mapError(
        (cause) =>
          new RemoveWorktreeRemoteError({
            message: "Failed to delete remote Azure DevOps Work Item branch",
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
    switch (input.repository.forge) {
      case "gitlab":
        return yield* removeGitLabRemoteArtifacts(input)
      case "azure-devops":
        return yield* removeAzureDevOpsRemoteArtifacts(input)
      case "github":
        return yield* removeGitHubRemoteArtifacts(input)
      default: {
        const _exhaustive: never = input.repository.forge
        return _exhaustive
      }
    }
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
              // Git can drop registration before the directory is fully gone
              // (e.g. Nx daemon recreates `.nx` mid-delete). Unregistered residual
              // files are recoverable via recursive remove below — never retry
              // `worktree remove` once the path is no longer listed.
              const stillListed = yield* worktreeListContains(
                gitRepository,
                worktreePath,
              )
              if (!stillListed) return
              return yield* error
            }),
          ),
        )

        yield* forceRemoveOnce.pipe(
          Effect.catchTag("GitCommandError", (error) =>
            Effect.gen(function* () {
              // Transient "Directory not empty" while still registered often
              // clears after a short wait; retry the git remove once only.
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
        // Unregistered residual (e.g. Nx rewriting `.nx` after Git dropped
        // registration) is removed via the filesystem, not a second
        // `worktree remove`. One brief retry covers concurrent writers,
        // including when the first remove throws ENOTEMPTY/EBUSY.
        yield* removeResidualDirectoryWithRetry(worktreePath)
        yield* runGit(gitRepository, ["worktree", "prune"])
        // Concurrent writers must not silently leave the path behind.
        if (yield* pathExists(worktreePath)) {
          return yield* new GitCommandError({
            message: `Residual worktree directory remains after cleanup: ${worktreePath}`,
            command: "rm",
            args: ["-rf", worktreePath],
            cwd: gitRepository.localPath,
            exitCode: 1,
            stderr: `path still exists after recursive remove: ${worktreePath}`,
          })
        }
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
 * success (idempotent). GitHub uses the coordinator-backed GitHub service
 * (a single combined close+delete operation); GitLab and Azure DevOps
 * cleanup close and delete as two sequential calls on their own services.
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
  | RemoveWorktreeRemoteError
