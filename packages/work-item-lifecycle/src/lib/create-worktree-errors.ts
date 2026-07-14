import { Data } from "effect"

export class CreateWorktreeRepositoryNotFoundError extends Data.TaggedError(
  "CreateWorktreeRepositoryNotFoundError",
)<{
  readonly repositoryId: string
}> {}

export class WorktreeConflictError extends Data.TaggedError(
  "WorktreeConflictError",
)<{
  readonly message: string
  readonly branchName: string
  readonly worktreePath: string
}> {}

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly message: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly exitCode: number
  readonly stderr: string
}> {}

export type CreateWorktreeError =
  | CreateWorktreeRepositoryNotFoundError
  | WorktreeConflictError
  | GitCommandError
