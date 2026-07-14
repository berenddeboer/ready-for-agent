import { Effect, FileSystem, Path } from "effect"
import { DbService, type RepositoryRecord } from "@ready-for-agent/db-service"
import {
  CreateWorktreeRepositoryNotFoundError,
  type GitCommandError,
} from "./create-worktree-errors.js"
import { type GitRepository, gitExitCode, runGit } from "./git.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { workItemBranchName, workItemWorktreePath } from "./worktree-names.js"

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
 * Inverse of createWorktree: unregister the worktree, delete the directory if
 * still present, and force-delete the Work Item branch.
 * Missing worktree/branch is success (idempotent).
 */
export const removeWorktree = (
  context: LifecycleStepContext,
  options: { readonly tmpDir?: string } = {},
) =>
  Effect.gen(function* () {
    const pathService = yield* Path.Path
    const repository = yield* resolveRepository(context.repositoryId)
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
  })

export type RemoveWorktreeError =
  | CreateWorktreeRepositoryNotFoundError
  | GitCommandError
