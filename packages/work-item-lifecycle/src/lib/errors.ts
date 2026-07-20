import { Schema } from "effect"

export * from "./create-worktree-errors.js"
export * from "./install-dependencies-errors.js"

export class NonTransactionalQueueError extends Schema.TaggedErrorClass<NonTransactionalQueueError>()(
  "NonTransactionalQueueError",
  {
    message: Schema.String,
  },
) {}

export class IssueNotFoundError extends Schema.TaggedErrorClass<IssueNotFoundError>()(
  "IssueNotFoundError",
  {
    repositoryId: Schema.String,
    githubIssueNumber: Schema.Finite,
  },
) {}

export class IssueNotOpenError extends Schema.TaggedErrorClass<IssueNotOpenError>()(
  "IssueNotOpenError",
  {
    repositoryId: Schema.String,
    githubIssueNumber: Schema.Finite,
    state: Schema.String,
  },
) {}

export class ParentIssueError extends Schema.TaggedErrorClass<ParentIssueError>()(
  "ParentIssueError",
  {
    repositoryId: Schema.String,
    githubIssueNumber: Schema.Finite,
  },
) {}

export class IssueBlockedError extends Schema.TaggedErrorClass<IssueBlockedError>()(
  "IssueBlockedError",
  {
    repositoryId: Schema.String,
    githubIssueNumber: Schema.Finite,
    blockerCount: Schema.Finite,
  },
) {}

export class UnfinishedWorkItemExistsError extends Schema.TaggedErrorClass<UnfinishedWorkItemExistsError>()(
  "UnfinishedWorkItemExistsError",
  {
    repositoryId: Schema.String,
    githubIssueNumber: Schema.Finite,
    workItemId: Schema.String,
  },
) {}

export class BuildModelNotConfiguredError extends Schema.TaggedErrorClass<BuildModelNotConfiguredError>()(
  "BuildModelNotConfiguredError",
  {
    message: Schema.String,
  },
) {}

export class WorkItemNotFoundError extends Schema.TaggedErrorClass<WorkItemNotFoundError>()(
  "WorkItemNotFoundError",
  {
    workItemId: Schema.String,
  },
) {}

export class StepRunNotFoundError extends Schema.TaggedErrorClass<StepRunNotFoundError>()(
  "StepRunNotFoundError",
  {
    stepRunId: Schema.String,
  },
) {}

export class WorkItemLifecycleDatabaseError extends Schema.TaggedErrorClass<WorkItemLifecycleDatabaseError>()(
  "WorkItemLifecycleDatabaseError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkItemTerminalError extends Schema.TaggedErrorClass<WorkItemTerminalError>()(
  "WorkItemTerminalError",
  {
    workItemId: Schema.String,
    state: Schema.String,
  },
) {}

export class ActiveStepRunExistsError extends Schema.TaggedErrorClass<ActiveStepRunExistsError>()(
  "ActiveStepRunExistsError",
  {
    workItemId: Schema.String,
    stepRunId: Schema.String,
    status: Schema.String,
  },
) {}

export class RetryNotEligibleError extends Schema.TaggedErrorClass<RetryNotEligibleError>()(
  "RetryNotEligibleError",
  {
    workItemId: Schema.String,
    reason: Schema.String,
  },
) {}

export class WorkItemHasRunningStepError extends Schema.TaggedErrorClass<WorkItemHasRunningStepError>()(
  "WorkItemHasRunningStepError",
  {
    workItemId: Schema.String,
    stepRunId: Schema.String,
  },
) {}

export class ResetCleanupError extends Schema.TaggedErrorClass<ResetCleanupError>()(
  "ResetCleanupError",
  {
    workItemId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class AbandonCleanupError extends Schema.TaggedErrorClass<AbandonCleanupError>()(
  "AbandonCleanupError",
  {
    workItemId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class NeedsHumanHandoffNotEligibleError extends Schema.TaggedErrorClass<NeedsHumanHandoffNotEligibleError>()(
  "NeedsHumanHandoffNotEligibleError",
  {
    workItemId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Ad-hoc step failure for tests and non-domain handler failures. */
export class LifecycleStepFailedError extends Schema.TaggedErrorClass<LifecycleStepFailedError>()(
  "LifecycleStepFailedError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
