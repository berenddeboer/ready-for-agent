import { Effect, FileSystem, Path } from "effect"
import type { RepositoryRecord } from "@ready-for-agent/db-service"
import { DbService } from "@ready-for-agent/db-service"
import {
  CreateWorktreeRepositoryNotFoundError,
  GitCommandError,
  WorktreeConflictError,
} from "./create-worktree-errors.js"
import { type GitRepository, gitExitCode, runGit } from "./git.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  workItemBranchName,
  workItemWorktreePath,
  worktreeParentPath,
} from "./worktree-names.js"

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

const parseDefaultBranchName = (lsRemoteOutput: string): string | null => {
  const match = lsRemoteOutput.match(/^ref: refs\/heads\/([^\t\n]+)\tHEAD$/m)
  const name = match?.[1]?.trim()
  return name === undefined || name === "" ? null : name
}

const resolveStartPoint = (repository: GitRepository) =>
  Effect.gen(function* () {
    const remoteHead = yield* runGit(repository, [
      "ls-remote",
      "--symref",
      "origin",
      "HEAD",
    ]).pipe(Effect.catchTag("GitCommandError", () => Effect.succeed("")))

    const defaultBranchName = parseDefaultBranchName(remoteHead)
    if (defaultBranchName !== null) {
      const defaultBranchRef = `refs/remotes/origin/${defaultBranchName}`
      yield* runGit(repository, [
        "fetch",
        "origin",
        `+refs/heads/${defaultBranchName}:${defaultBranchRef}`,
      ]).pipe(Effect.catchTag("GitCommandError", () => Effect.void))

      const remoteRefCode = yield* gitExitCode(repository, [
        "show-ref",
        "--verify",
        defaultBranchRef,
      ])
      if (remoteRefCode === 0) {
        return defaultBranchRef
      }
    }

    const headCode = yield* gitExitCode(repository, [
      "rev-parse",
      "--verify",
      "HEAD",
    ])
    if (headCode === 0) {
      return "HEAD"
    }

    return yield* new GitCommandError({
      message: "Unable to resolve a start point for the worktree",
      command: "git",
      args: repository.isBare
        ? ["--git-dir", repository.localPath, "rev-parse", "--verify", "HEAD"]
        : ["-C", repository.localPath, "rev-parse", "--verify", "HEAD"],
      exitCode: 1,
      stderr: "No origin default branch and no local HEAD",
    })
  })

const branchExists = (repository: GitRepository, branchName: string) =>
  gitExitCode(repository, [
    "show-ref",
    "--verify",
    `refs/heads/${branchName}`,
  ]).pipe(Effect.map((code) => code === 0))

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

const branchCheckedOutAt = (
  repository: GitRepository,
  branchName: string,
  worktreePath: string,
) =>
  runGit(repository, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map((output) => {
      const normalized = worktreePath.replace(/[/\\]+$/, "")
      const blocks = output.split("\n\n")
      return blocks.some((block) => {
        const lines = block.split("\n")
        const pathLine = lines.find((line) => line.startsWith("worktree "))
        const branchLine = lines.find((line) => line.startsWith("branch "))
        if (pathLine === undefined || branchLine === undefined) {
          return false
        }
        const path = pathLine.slice("worktree ".length).replace(/[/\\]+$/, "")
        const branch = branchLine.slice("branch ".length)
        return (
          path === normalized &&
          (branch === `refs/heads/${branchName}` || branch === branchName)
        )
      })
    }),
  )

const ensureParentDirectory = (parentPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(parentPath, { recursive: true })
  })

const pathExists = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(path)
  })

const realPath = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.realPath(path)
  })

export const createWorktree = (
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

    const worktreePath = pathService.resolve(plannedPath)
    const parentPath = pathService.resolve(
      worktreeParentPath({
        localPath: repository.localPath,
        isBare: repository.isBare,
        githubOwner: repository.githubOwner,
        githubRepo: repository.githubRepo,
        tmpDir: options.tmpDir,
      }),
    )

    const hasBranch = yield* branchExists(gitRepository, branchName)
    const pathPresent = yield* pathExists(worktreePath)

    if (pathPresent) {
      const absoluteExisting = yield* realPath(worktreePath)
      const listed = yield* worktreeListContains(
        gitRepository,
        absoluteExisting,
      )
      if (!listed) {
        return yield* new WorktreeConflictError({
          message: `Path already exists and is not a worktree for this Repository: ${worktreePath}`,
          branchName,
          worktreePath,
        })
      }

      const correctCheckout = yield* branchCheckedOutAt(
        gitRepository,
        branchName,
        absoluteExisting,
      )
      if (!correctCheckout) {
        return yield* new WorktreeConflictError({
          message: `Existing worktree at ${worktreePath} is not checked out on branch ${branchName}`,
          branchName,
          worktreePath,
        })
      }

      return absoluteExisting
    }

    if (hasBranch) {
      return yield* new WorktreeConflictError({
        message: `Branch ${branchName} already exists without worktree at ${worktreePath}`,
        branchName,
        worktreePath,
      })
    }

    yield* ensureParentDirectory(parentPath)

    const startPoint = yield* resolveStartPoint(gitRepository)
    yield* runGit(gitRepository, [
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      startPoint,
    ])

    return yield* realPath(worktreePath)
  })
