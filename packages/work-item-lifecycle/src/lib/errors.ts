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
    issueNumber: Schema.Finite,
  },
) {}

export class IssueNotOpenError extends Schema.TaggedErrorClass<IssueNotOpenError>()(
  "IssueNotOpenError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    state: Schema.String,
  },
) {}

export class ParentIssueError extends Schema.TaggedErrorClass<ParentIssueError>()(
  "ParentIssueError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
  },
) {}

/** The Issue is not a Parent Issue (no children). */
export class NotAParentIssueError extends Schema.TaggedErrorClass<NotAParentIssueError>()(
  "NotAParentIssueError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
  },
) {}

/**
 * The Issue hierarchy is not a Supported Issue Hierarchy (e.g. grandchildren).
 */
export class UnsupportedIssueHierarchyError extends Schema.TaggedErrorClass<UnsupportedIssueHierarchyError>()(
  "UnsupportedIssueHierarchyError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    message: Schema.String,
  },
) {}

/**
 * Parent Issue is not eligible for Implement all with auto-merge (no open
 * Child Issues, or concurrent enrollment conflict).
 */
export class ImplementAllWithAutoMergeNotEligibleError extends Schema.TaggedErrorClass<ImplementAllWithAutoMergeNotEligibleError>()(
  "ImplementAllWithAutoMergeNotEligibleError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    reason: Schema.String,
  },
) {}

export class IssueBlockedError extends Schema.TaggedErrorClass<IssueBlockedError>()(
  "IssueBlockedError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    blockerCount: Schema.Finite,
  },
) {}

/** Queue requires listed blockers; Implement Now requires none. */
export class IssueNotBlockedError extends Schema.TaggedErrorClass<IssueNotBlockedError>()(
  "IssueNotBlockedError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
  },
) {}

export class UnfinishedWorkItemExistsError extends Schema.TaggedErrorClass<UnfinishedWorkItemExistsError>()(
  "UnfinishedWorkItemExistsError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    workItemId: Schema.String,
  },
) {}

/** Pause/Start/force-start are not allowed while Waiting for blockers. */
export class WorkItemWaitingForBlockersError extends Schema.TaggedErrorClass<WorkItemWaitingForBlockersError>()(
  "WorkItemWaitingForBlockersError",
  {
    workItemId: Schema.String,
    operation: Schema.String,
  },
) {}

export class BuildModelNotConfiguredError extends Schema.TaggedErrorClass<BuildModelNotConfiguredError>()(
  "BuildModelNotConfiguredError",
  {
    message: Schema.String,
  },
) {}

/**
 * Implement With rejected a complete-profile input (partial fields, catalog
 * membership, or Thinking Level) before creating a Work Item.
 */
export class InvalidExecutionProfileError extends Schema.TaggedErrorClass<InvalidExecutionProfileError>()(
  "InvalidExecutionProfileError",
  {
    message: Schema.String,
    field: Schema.optionalKey(Schema.String),
  },
) {}

export class AgentBackendUnavailableError extends Schema.TaggedErrorClass<AgentBackendUnavailableError>()(
  "AgentBackendUnavailableError",
  {
    message: Schema.String,
    reason: Schema.String,
  },
) {}

export class WorkItemNotFoundError extends Schema.TaggedErrorClass<WorkItemNotFoundError>()(
  "WorkItemNotFoundError",
  {
    workItemId: Schema.String,
  },
) {}

/** No Work Item owns this opaque backend Session ID. */
export class SessionIdNotFoundError extends Schema.TaggedErrorClass<SessionIdNotFoundError>()(
  "SessionIdNotFoundError",
  {
    sessionId: Schema.String,
  },
) {}

/** More than one Work Item owns this opaque backend Session ID. */
export class SessionIdAmbiguousError extends Schema.TaggedErrorClass<SessionIdAmbiguousError>()(
  "SessionIdAmbiguousError",
  {
    sessionId: Schema.String,
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

/** Interrupt is legal only while paused with a running Step Run. */
export class InterruptNotEligibleError extends Schema.TaggedErrorClass<InterruptNotEligibleError>()(
  "InterruptNotEligibleError",
  {
    workItemId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Autonomous Retry Budget exhausted for this Work Item at its current step. */
export class AutonomousRetryLimitReachedError extends Schema.TaggedErrorClass<AutonomousRetryLimitReachedError>()(
  "AutonomousRetryLimitReachedError",
  {
    workItemId: Schema.String,
    used: Schema.Finite,
    max: Schema.Finite,
  },
) {}

/** Structured provider retry time has not elapsed; consume no budget. */
export class AutonomousRetryDeferredError extends Schema.TaggedErrorClass<AutonomousRetryDeferredError>()(
  "AutonomousRetryDeferredError",
  {
    workItemId: Schema.String,
    retryAt: Schema.Finite,
  },
) {}

export class InvalidAutonomousRetryLimitError extends Schema.TaggedErrorClass<InvalidAutonomousRetryLimitError>()(
  "InvalidAutonomousRetryLimitError",
  {
    maxRetries: Schema.Finite,
    message: Schema.String,
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
