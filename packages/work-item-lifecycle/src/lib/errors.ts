import { Schema } from "effect"

export * from "./create-worktree-errors.js"
export * from "./install-dependencies-errors.js"

export class NonTransactionalQueueError extends Schema.TaggedError<NonTransactionalQueueError>()(
  "NonTransactionalQueueError",
  {
    message: Schema.String,
  },
) {}

export class IssueNotFoundError extends Schema.TaggedError<IssueNotFoundError>()(
  "IssueNotFoundError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    nativeId: Schema.optionalKey(Schema.String),
  },
) {}

/** More than one live Issue shares this number under the current tracker. */
export class IssueIdentityAmbiguousError extends Schema.TaggedError<IssueIdentityAmbiguousError>()(
  "IssueIdentityAmbiguousError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    message: Schema.String,
  },
) {}

export class IssueNotOpenError extends Schema.TaggedError<IssueNotOpenError>()(
  "IssueNotOpenError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    state: Schema.String,
  },
) {}

export class ParentIssueError extends Schema.TaggedError<ParentIssueError>()(
  "ParentIssueError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
  },
) {}

/** The Issue is not a Parent Issue (no children). */
export class NotAParentIssueError extends Schema.TaggedError<NotAParentIssueError>()(
  "NotAParentIssueError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
  },
) {}

/**
 * The Issue hierarchy is not a Supported Issue Hierarchy (e.g. grandchildren).
 */
export class UnsupportedIssueHierarchyError extends Schema.TaggedError<UnsupportedIssueHierarchyError>()(
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
export class ImplementAllWithAutoMergeNotEligibleError extends Schema.TaggedError<ImplementAllWithAutoMergeNotEligibleError>()(
  "ImplementAllWithAutoMergeNotEligibleError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    reason: Schema.String,
  },
) {}

/**
 * Implement With cannot request an Implement Locally pause on a Parent Issue.
 * Bulk enrollment is always remote; the pause option fails closed.
 */
export class ParentImplementWithPauseNotAllowedError extends Schema.TaggedError<ParentImplementWithPauseNotAllowedError>()(
  "ParentImplementWithPauseNotAllowedError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
  },
) {}

export class IssueBlockedError extends Schema.TaggedError<IssueBlockedError>()(
  "IssueBlockedError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    blockerCount: Schema.Finite,
  },
) {}

/** Queue requires listed blockers; Implement Now requires none. */
export class IssueNotBlockedError extends Schema.TaggedError<IssueNotBlockedError>()(
  "IssueNotBlockedError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
  },
) {}

export class UnfinishedWorkItemExistsError extends Schema.TaggedError<UnfinishedWorkItemExistsError>()(
  "UnfinishedWorkItemExistsError",
  {
    repositoryId: Schema.String,
    issueNumber: Schema.Finite,
    workItemId: Schema.String,
  },
) {}

/** Pause/Start/force-start are not allowed while Waiting for blockers. */
export class WorkItemWaitingForBlockersError extends Schema.TaggedError<WorkItemWaitingForBlockersError>()(
  "WorkItemWaitingForBlockersError",
  {
    workItemId: Schema.String,
    operation: Schema.String,
  },
) {}

export class BuildModelNotConfiguredError extends Schema.TaggedError<BuildModelNotConfiguredError>()(
  "BuildModelNotConfiguredError",
  {
    message: Schema.String,
  },
) {}

/**
 * Implement With rejected a complete-profile input (partial fields, catalog
 * membership, or Thinking Level) before creating a Work Item.
 */
export class InvalidExecutionProfileError extends Schema.TaggedError<InvalidExecutionProfileError>()(
  "InvalidExecutionProfileError",
  {
    message: Schema.String,
    field: Schema.optionalKey(Schema.String),
  },
) {}

export class AgentBackendUnavailableError extends Schema.TaggedError<AgentBackendUnavailableError>()(
  "AgentBackendUnavailableError",
  {
    message: Schema.String,
    reason: Schema.String,
  },
) {}

export class WorkItemNotFoundError extends Schema.TaggedError<WorkItemNotFoundError>()(
  "WorkItemNotFoundError",
  {
    workItemId: Schema.String,
  },
) {}

/** No Work Item owns this opaque backend Session ID. */
export class SessionIdNotFoundError extends Schema.TaggedError<SessionIdNotFoundError>()(
  "SessionIdNotFoundError",
  {
    sessionId: Schema.String,
  },
) {}

/** More than one Work Item owns this opaque backend Session ID. */
export class SessionIdAmbiguousError extends Schema.TaggedError<SessionIdAmbiguousError>()(
  "SessionIdAmbiguousError",
  {
    sessionId: Schema.String,
  },
) {}

export class StepRunNotFoundError extends Schema.TaggedError<StepRunNotFoundError>()(
  "StepRunNotFoundError",
  {
    stepRunId: Schema.String,
  },
) {}

export class WorkItemLifecycleDatabaseError extends Schema.TaggedError<WorkItemLifecycleDatabaseError>()(
  "WorkItemLifecycleDatabaseError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkItemTerminalError extends Schema.TaggedError<WorkItemTerminalError>()(
  "WorkItemTerminalError",
  {
    workItemId: Schema.String,
    state: Schema.String,
  },
) {}

/**
 * CI Gate Bypass is offered only to an ordinary Work Item while a CI Failure
 * Incident is active and Closed. A CI Repair Work Item is never eligible: it
 * crosses a Closed gate by origin. The class tag stays
 * CiRepairNotAvailableError so existing failures remain recognizable.
 */
export class CiRepairNotAvailableError extends Schema.TaggedError<CiRepairNotAvailableError>()(
  "CiRepairNotAvailableError",
  {
    repositoryId: Schema.String,
    workItemId: Schema.optionalKey(Schema.String),
    message: Schema.String,
  },
) {}

/** Start CI Repair was requested while the Repository CI Gate is not Closed. */
export class CiRepairGateNotClosedError extends Schema.TaggedError<CiRepairGateNotClosedError>()(
  "CiRepairGateNotClosedError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
  },
) {}

/** Start CI Repair has no observed default branch to name the Work Item. */
export class CiRepairDefaultBranchMissingError extends Schema.TaggedError<CiRepairDefaultBranchMissingError>()(
  "CiRepairDefaultBranchMissingError",
  {
    repositoryId: Schema.String,
    message: Schema.String,
  },
) {}

export class ActiveStepRunExistsError extends Schema.TaggedError<ActiveStepRunExistsError>()(
  "ActiveStepRunExistsError",
  {
    workItemId: Schema.String,
    stepRunId: Schema.String,
    status: Schema.String,
  },
) {}

export class RetryNotEligibleError extends Schema.TaggedError<RetryNotEligibleError>()(
  "RetryNotEligibleError",
  {
    workItemId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Interrupt is legal only while paused with a running Step Run. */
export class InterruptNotEligibleError extends Schema.TaggedError<InterruptNotEligibleError>()(
  "InterruptNotEligibleError",
  {
    workItemId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Autonomous Retry Budget exhausted for this Work Item at its current step. */
export class AutonomousRetryLimitReachedError extends Schema.TaggedError<AutonomousRetryLimitReachedError>()(
  "AutonomousRetryLimitReachedError",
  {
    workItemId: Schema.String,
    used: Schema.Finite,
    max: Schema.Finite,
  },
) {}

/** Structured provider retry time has not elapsed; consume no budget. */
export class AutonomousRetryDeferredError extends Schema.TaggedError<AutonomousRetryDeferredError>()(
  "AutonomousRetryDeferredError",
  {
    workItemId: Schema.String,
    retryAt: Schema.Finite,
  },
) {}

export class InvalidAutonomousRetryLimitError extends Schema.TaggedError<InvalidAutonomousRetryLimitError>()(
  "InvalidAutonomousRetryLimitError",
  {
    maxRetries: Schema.Finite,
    message: Schema.String,
  },
) {}

export class WorkItemHasRunningStepError extends Schema.TaggedError<WorkItemHasRunningStepError>()(
  "WorkItemHasRunningStepError",
  {
    workItemId: Schema.String,
    stepRunId: Schema.String,
  },
) {}

export class ResetCleanupError extends Schema.TaggedError<ResetCleanupError>()(
  "ResetCleanupError",
  {
    workItemId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class AbandonCleanupError extends Schema.TaggedError<AbandonCleanupError>()(
  "AbandonCleanupError",
  {
    workItemId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class NeedsHumanHandoffNotEligibleError extends Schema.TaggedError<NeedsHumanHandoffNotEligibleError>()(
  "NeedsHumanHandoffNotEligibleError",
  {
    workItemId: Schema.String,
    reason: Schema.String,
  },
) {}

/** Ad-hoc step failure for tests and non-domain handler failures. */
export class LifecycleStepFailedError extends Schema.TaggedError<LifecycleStepFailedError>()(
  "LifecycleStepFailedError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
