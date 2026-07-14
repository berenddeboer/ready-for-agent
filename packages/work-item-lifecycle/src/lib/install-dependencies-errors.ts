import { Data } from "effect"

export class WorktreeContextMissingError extends Data.TaggedError(
  "WorktreeContextMissingError",
)<{
  readonly workItemId: string
  readonly message: string
}> {}

export class InvalidWorktreeContextError extends Data.TaggedError(
  "InvalidWorktreeContextError",
)<{
  readonly workItemId: string
  readonly worktreePath: string
  readonly message: string
}> {}

export class InstallCommandError extends Data.TaggedError(
  "InstallCommandError",
)<{
  readonly message: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly exitCode: number
  readonly stderr: string
}> {}

export class InstallDependenciesFallbackError extends Data.TaggedError(
  "InstallDependenciesFallbackError",
)<{
  readonly message: string
  readonly worktreePath: string
  readonly cause?: unknown
}> {}

export type InstallDependenciesError =
  | WorktreeContextMissingError
  | InvalidWorktreeContextError
  | InstallCommandError
  | InstallDependenciesFallbackError
