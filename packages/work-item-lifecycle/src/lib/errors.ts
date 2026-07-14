import { Data } from "effect"

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

export class WorkItemLifecycleDatabaseError extends Data.TaggedError(
  "WorkItemLifecycleDatabaseError",
)<{
  readonly message: string
  readonly cause?: unknown
}> {}
