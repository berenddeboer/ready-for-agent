import { Data } from "effect"

export * from "./create-worktree-errors.js"
export * from "./install-dependencies-errors.js"

export class NonTransactionalQueueError extends Data.TaggedError(
  "NonTransactionalQueueError",
)<{
  readonly message: string
}> {}

export class IssueNotFoundError extends Data.TaggedError("IssueNotFoundError")<{
  readonly repositoryId: string
  readonly githubIssueNumber: number
}> {}

export class IssueNotOpenError extends Data.TaggedError("IssueNotOpenError")<{
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly state: string
}> {}

export class ParentIssueError extends Data.TaggedError("ParentIssueError")<{
  readonly repositoryId: string
  readonly githubIssueNumber: number
}> {}

export class IssueBlockedError extends Data.TaggedError("IssueBlockedError")<{
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly blockerCount: number
}> {}

export class UnfinishedWorkItemExistsError extends Data.TaggedError(
  "UnfinishedWorkItemExistsError",
)<{
  readonly repositoryId: string
  readonly githubIssueNumber: number
  readonly workItemId: string
}> {}

export class WorkItemNotFoundError extends Data.TaggedError(
  "WorkItemNotFoundError",
)<{
  readonly workItemId: string
}> {}

export class StepRunNotFoundError extends Data.TaggedError(
  "StepRunNotFoundError",
)<{
  readonly stepRunId: string
}> {}

export class WorkItemLifecycleDatabaseError extends Data.TaggedError(
  "WorkItemLifecycleDatabaseError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class WorkItemTerminalError extends Data.TaggedError(
  "WorkItemTerminalError",
)<{
  readonly workItemId: string
  readonly state: string
}> {}

export class ActiveStepRunExistsError extends Data.TaggedError(
  "ActiveStepRunExistsError",
)<{
  readonly workItemId: string
  readonly stepRunId: string
  readonly status: string
}> {}

export class RetryNotEligibleError extends Data.TaggedError(
  "RetryNotEligibleError",
)<{
  readonly workItemId: string
  readonly reason: string
}> {}

export class WorkItemHasRunningStepError extends Data.TaggedError(
  "WorkItemHasRunningStepError",
)<{
  readonly workItemId: string
  readonly stepRunId: string
}> {}

export class ResetCleanupError extends Data.TaggedError("ResetCleanupError")<{
  readonly workItemId: string
  readonly message: string
  readonly cause: unknown
}> {}

export class AbandonCleanupError extends Data.TaggedError(
  "AbandonCleanupError",
)<{
  readonly workItemId: string
  readonly message: string
  readonly cause: unknown
}> {}

export class NeedsHumanHandoffNotEligibleError extends Data.TaggedError(
  "NeedsHumanHandoffNotEligibleError",
)<{
  readonly workItemId: string
  readonly reason: string
}> {}
