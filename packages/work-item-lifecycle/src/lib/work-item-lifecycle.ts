import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  agentBackendLabel,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"
import {
  type DatabaseError,
  DbService,
  type RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import {
  GitHubService,
  type GitHubThrottledError,
  type PullRequestLifecycleStatus,
  formatUserFacingError,
  isGitHubThrottledError,
  sanitizeUserFacingText,
} from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import {
  OperationalLifecycleStep as OperationalLifecycleStepSchema,
  type WorkItemPredicateShape,
  evaluateActionableIssue,
  evaluateImplementableIssue,
  evaluateUnfinishedWorkItem,
  isAgentDependentLifecycleStep,
} from "@ready-for-agent/lifecycle-model"
import {
  type AcknowledgeError,
  EnqueueError,
  InvalidQueueNameError,
  type JobNotFoundError,
  QueueService,
} from "@ready-for-agent/queue-service"
import {
  CurrentCapturedAgentBackendId,
  CurrentStepRun,
} from "./agent-turn-limiter.js"
import { CloseIssueEligibilityError } from "./close-issue-errors.js"
import {
  AbandonCleanupError,
  ActiveStepRunExistsError,
  AgentBackendUnavailableError,
  BuildModelNotConfiguredError,
  ImplementAllWithAutoMergeNotEligibleError,
  IssueBlockedError,
  IssueNotBlockedError,
  IssueNotFoundError,
  IssueNotOpenError,
  NeedsHumanHandoffNotEligibleError,
  NonTransactionalQueueError,
  NotAParentIssueError,
  ParentIssueError,
  ResetCleanupError,
  RetryNotEligibleError,
  StepRunNotFoundError,
  UnfinishedWorkItemExistsError,
  UnsupportedIssueHierarchyError,
  WorkItemHasRunningStepError,
  WorkItemLifecycleDatabaseError,
  WorkItemNotFoundError,
  WorkItemTerminalError,
  WorkItemWaitingForBlockersError,
} from "./errors.js"
import {
  type LifecycleStepContext,
  LifecycleSteps,
  type RunHandlerError,
} from "./lifecycle-steps.js"
import { PrStatusChecksUnresolvedError } from "./pr-status-checks.js"
import {
  PreCommitHookFailedError,
  PreCommitStageError,
} from "./pre-commit-errors.js"
import {
  type AgentModelSelection,
  agentModelCatalogViolation,
  resolveAgentModelsForBackend,
} from "./resolve-agent-models.js"
import {
  formatAcceptedReviewSummary,
  formatDeferredReviewSummary,
} from "./review.js"
import { computeProductiveElapsedMs } from "./step-run-productive-time.js"
import { applyCheckedLifecycleTransition } from "./transition-relation-check.js"
import {
  COMPLETED_WORK_ITEMS_DEFAULT_PAGE_SIZE,
  COMPLETED_WORK_ITEMS_MAX_PAGE_SIZE,
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  type LifecycleMaxDurations,
  type MergeMode,
  type OperationalLifecycleStep,
  STEP_RUN_REASON,
  type StepRunId,
  type StepRunReasonCode,
  type StepRunRecord,
  StepRunStatus,
  WORK_ITEM_LIFECYCLE_QUEUE,
  type WorkItemId,
  type WorkItemLifecycleConfig,
  type WorkItemRecord,
  type WorkItemState,
  WorkItemStepJob,
  WorkItemWakeJob,
  isRetryableFailedWorkItem,
  isTerminalWorkItemState,
  makeStepRunId,
  makeWorkItemId,
} from "./types.js"
import { workItemBranchName } from "./worktree-names.js"

export { WAITING_FOR_WORKER_SLOT_MESSAGE } from "./types.js"

const currentIssuePredicateInput = <Issue extends object>(
  issue: Issue | undefined,
): (Issue & { readonly isCurrentIssue: true }) | undefined =>
  issue === undefined ? undefined : { ...issue, isCurrentIssue: true }

const workItemPredicateInput = (
  workItem: WorkItemRecord,
): WorkItemPredicateShape => ({
  id: workItem.id,
  state: workItem.state,
  canRetry: isRetryableFailedWorkItem(workItem),
})

const formatSqlError = (error: SqlError): string => {
  const parts: string[] = [error.message]
  let current: unknown = error.cause
  while (current) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>
      if (typeof obj["message"] === "string") {
        parts.push(obj["message"])
      }
      current = "cause" in obj ? obj["cause"] : undefined
    } else if (typeof current === "string") {
      parts.push(current)
      break
    } else {
      break
    }
  }
  return parts.join(" -> ")
}

const isUnfinishedWorkItemUniqueViolation = (error: SqlError): boolean => {
  const message = formatSqlError(error).toLowerCase()
  return (
    (message.includes("unique") || message.includes("sqlite_constraint")) &&
    (message.includes("work_item_one_unfinished_uidx") ||
      message.includes("work_item_one_unfinished_v2_uidx") ||
      message.includes("work_item_one_unfinished_v3_uidx") ||
      message.includes("work_item_one_unfinished_v4_uidx") ||
      (message.includes("work_item.repository_id") &&
        message.includes("work_item.issue_number")))
  )
}

const isActiveStepRunUniqueViolation = (error: SqlError): boolean => {
  const message = formatSqlError(error).toLowerCase()
  return (
    (message.includes("unique") || message.includes("sqlite_constraint")) &&
    (message.includes("step_run_one_active_uidx") ||
      message.includes("one_active") ||
      (message.includes("step_run") && message.includes("work_item_id")))
  )
}

const conciseMessage = (value: unknown, fallback: string): string =>
  formatUserFacingError(value, fallback, 500)

const handlerFailureMessage = (error: RunHandlerError): string => {
  if (
    error instanceof PreCommitHookFailedError ||
    error instanceof PreCommitStageError
  ) {
    return sanitizeUserFacingText(`${error.message}\n${error.output}`)
  }
  return conciseMessage(error, "Lifecycle Step handler failed")
}

type HandlerExitError =
  | RunHandlerError
  | GitHubThrottledError
  | Cause.TimeoutError

const closeIssueEligibilityFailure = (
  cause: Cause.Cause<HandlerExitError>,
): {
  readonly failureCode: string
  readonly failureMessage: string
} | null => {
  const errorOption = Cause.findErrorOption(cause)
  if (Option.isNone(errorOption)) {
    return null
  }
  const error = errorOption.value
  if (error instanceof CloseIssueEligibilityError) {
    return {
      failureCode: error.failureCode,
      failureMessage: error.message,
    }
  }
  return null
}

const classifyHandlerFailure = (
  cause: Cause.Cause<HandlerExitError>,
): {
  readonly reasonCode: string
  readonly reasonMessage: string
} => {
  const eligibility = closeIssueEligibilityFailure(cause)
  if (eligibility !== null) {
    return {
      reasonCode: eligibility.failureCode,
      reasonMessage: eligibility.failureMessage,
    }
  }

  const errorOption = Cause.findErrorOption(cause)
  if (Option.isSome(errorOption)) {
    const error = errorOption.value
    if (Predicate.isTagged(error, "TimeoutError")) {
      return {
        reasonCode: STEP_RUN_REASON.timeout,
        reasonMessage:
          "Lifecycle Step exceeded its configured maximum duration",
      }
    }
    if (error instanceof PrStatusChecksUnresolvedError) {
      return {
        reasonCode: STEP_RUN_REASON.prStatusChecksUnresolved,
        reasonMessage: error.message,
      }
    }
    return {
      reasonCode: STEP_RUN_REASON.handlerFailed,
      reasonMessage: handlerFailureMessage(error),
    }
  }

  const defect = Cause.findDefect(cause)
  if (Result.isSuccess(defect)) {
    return {
      reasonCode: STEP_RUN_REASON.handlerDefect,
      reasonMessage: conciseMessage(
        defect.success,
        "Lifecycle Step handler defect",
      ),
    }
  }

  return {
    reasonCode: STEP_RUN_REASON.handlerFailed,
    reasonMessage: conciseMessage(
      Cause.squash(cause),
      "Lifecycle Step handler failed",
    ),
  }
}

const toDatabaseError = (error: SqlError) =>
  new WorkItemLifecycleDatabaseError({
    message: `Database error: ${formatSqlError(error)}`,
    cause: error,
  })

type WorkItemRow = {
  readonly id: string
  readonly repository_id: string
  readonly issue_number: number
  readonly issue_title: string | null
  readonly pull_request_number: number | null
  readonly agent_backend: string
  readonly state: WorkItemState
  readonly state_ready_at: number
  readonly paused: boolean | number
  readonly waiting_since: number | null
  readonly waiting_for_blockers: boolean | number
  readonly merge_mode: string | null
  readonly holds_worker_slot: boolean | number
  readonly pause_before_step: OperationalLifecycleStep | null
  readonly worktree_path: string | null
  readonly starting_commit_oid: string | null
  readonly completion_summary: string | null
  readonly publication_title: string | null
  readonly publication_body: string | null
  readonly session_id: string | null
  readonly failure_code: string | null
  readonly failure_message: string | null
  readonly check_start_anchor_at: number | null
  readonly check_start_anchor_head_sha: string | null
  readonly check_start_observed_head_sha: string | null
  readonly check_start_observed_head_at: number | null
  readonly check_start_last_observed_is_draft: number | null
  readonly created_at: number
  readonly updated_at: number
}

const decodeMergeMode = (value: string | null | undefined): MergeMode =>
  value === "always" ? "always" : "ordinary"

/**
 * After pre-merge lifecycle settles: Always skips Decide PR Merge.
 */
const nextStateAfterReadyForMerge = (
  mergeMode: string | null | undefined,
): "decide_pr_merge" | "merge_pr" =>
  decodeMergeMode(mergeMode) === "always" ? "merge_pr" : "decide_pr_merge"

type StepRunRow = {
  readonly id: string
  readonly work_item_id: string
  readonly step: OperationalLifecycleStep
  readonly status: StepRunStatus
  readonly queue_job_id: string | null
  readonly queued_at: number
  readonly started_at: number | null
  readonly finished_at: number | null
  readonly reason_code: string | null
  readonly reason_message: string | null
  readonly postponed_until: number | null
  readonly session_wait_ms: number | null
  readonly session_wait_started_at: number | null
}

const PostponedStepRunIdRow = Schema.Struct({ id: Schema.String })
const LatestStepRunStatusRow = Schema.Struct({
  step: OperationalLifecycleStepSchema,
  status: StepRunStatus,
  postponed_until: Schema.NullOr(Schema.Finite),
})
const StartedWorkItemRow = Schema.Struct({
  id: Schema.String,
  state: OperationalLifecycleStepSchema,
})
const ActiveStepRunRow = Schema.Struct({ id: Schema.String })
const LatestStepRunDeadlineRow = Schema.Struct({
  status: StepRunStatus,
  postponed_until: Schema.NullOr(Schema.Finite),
})

const decodePostponedStepRunIdRows = (rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(PostponedStepRunIdRow))(rows).pipe(
    Effect.mapError(
      (error) =>
        new WorkItemLifecycleDatabaseError({
          message: `Invalid Postponed Step Run update row: ${String(error)}`,
          cause: error,
        }),
    ),
  )

const decodeLatestStepRunStatusRows = (rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(LatestStepRunStatusRow))(rows).pipe(
    Effect.mapError(
      (error) =>
        new WorkItemLifecycleDatabaseError({
          message: `Invalid latest Step Run status row: ${String(error)}`,
          cause: error,
        }),
    ),
  )

const decodeStartedWorkItemRows = (rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(StartedWorkItemRow))(rows).pipe(
    Effect.mapError(
      (error) =>
        new WorkItemLifecycleDatabaseError({
          message: `Invalid started Work Item row: ${String(error)}`,
          cause: error,
        }),
    ),
  )

const decodeActiveStepRunRows = (rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(ActiveStepRunRow))(rows).pipe(
    Effect.mapError(
      (error) =>
        new WorkItemLifecycleDatabaseError({
          message: `Invalid active Step Run row: ${String(error)}`,
          cause: error,
        }),
    ),
  )

const decodeLatestStepRunDeadlineRows = (rows: unknown) =>
  Schema.decodeUnknownEffect(Schema.Array(LatestStepRunDeadlineRow))(rows).pipe(
    Effect.mapError(
      (error) =>
        new WorkItemLifecycleDatabaseError({
          message: `Invalid latest Step Run deadline row: ${String(error)}`,
          cause: error,
        }),
    ),
  )

const STEP_RUN_SELECT_COLUMNS = `id, work_item_id, step, status, queue_job_id, queued_at,
                        started_at, finished_at, reason_code, reason_message,
                        postponed_until, session_wait_ms, session_wait_started_at`

const deriveQueueWaitMs = (row: StepRunRow, nowMs: number): number => {
  const endMs = row.started_at ?? row.finished_at ?? nowMs
  return Math.max(0, endMs - row.queued_at)
}

const deriveExecutionDurationMs = (
  row: StepRunRow,
  nowMs: number,
): number | null => {
  if (row.started_at === null) {
    return null
  }
  const endMs = row.finished_at ?? nowMs
  return Math.max(0, endMs - row.started_at)
}

const toStepRunRecord = (row: StepRunRow, nowMs: number): StepRunRecord => {
  const common = {
    id: row.id as StepRunId,
    workItemId: row.work_item_id as WorkItemId,
    step: row.step,
    queueJobId: row.queue_job_id,
    queuedAt: new Date(row.queued_at),
    startedAt: row.started_at === null ? null : new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
    reasonCode: row.reason_code,
    reasonMessage: row.reason_message,
    queueWaitMs: deriveQueueWaitMs(row, nowMs),
    executionDurationMs: deriveExecutionDurationMs(row, nowMs),
  }
  if (row.status === "postponed") {
    if (row.postponed_until === null) {
      throw new Error("Postponed Step Run is missing postponed_until")
    }
    if (row.finished_at === null) {
      throw new Error("Postponed Step Run is missing finished_at")
    }
    return {
      ...common,
      status: "postponed",
      finishedAt: new Date(row.finished_at),
      postponedUntil: new Date(row.postponed_until),
    }
  }
  return { ...common, status: row.status, postponedUntil: null }
}

const toWorkItemRecord = (
  row: WorkItemRow,
  stepRuns: readonly StepRunRecord[],
  nowMs: number,
): WorkItemRecord => ({
  id: row.id as WorkItemId,
  repositoryId: row.repository_id,
  issueNumber: row.issue_number,
  issueTitle: row.issue_title,
  pullRequestNumber: row.pull_request_number,
  agentBackend: row.agent_backend,
  state: row.state,
  stateReadyAt: new Date(row.state_ready_at),
  paused: Boolean(row.paused),
  waitingSince:
    row.waiting_since === null || row.waiting_since === undefined
      ? null
      : new Date(row.waiting_since),
  waitingForBlockers: Boolean(row.waiting_for_blockers),
  mergeMode: decodeMergeMode(row.merge_mode),
  holdsWorkerSlot: Boolean(row.holds_worker_slot),
  pauseBeforeStep: row.pause_before_step,
  worktreePath: row.worktree_path,
  startingCommitOid: row.starting_commit_oid,
  completionSummary: row.completion_summary,
  publicationTitle: row.publication_title,
  publicationBody: row.publication_body,
  sessionId: row.session_id,
  failureCode: row.failure_code,
  failureMessage: row.failure_message,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  stateResidenceMs: Math.max(0, nowMs - row.state_ready_at),
  stepRuns,
})

const WORK_ITEM_SELECT_COLUMNS = `id, repository_id, issue_number, issue_title, agent_backend,
                   state, state_ready_at, paused, waiting_since, waiting_for_blockers, merge_mode,
                   holds_worker_slot,
                   pause_before_step, worktree_path, starting_commit_oid, completion_summary,
                   publication_title, publication_body, session_id,
                   pull_request_number, failure_code,
                    failure_message, check_start_anchor_at, check_start_anchor_head_sha,
                    check_start_observed_head_sha, check_start_observed_head_at,
                    check_start_last_observed_is_draft,
                    created_at, updated_at`

const EMPTY_AGENT_MODEL_SELECTION: AgentModelSelection = {
  model: "",
  thinkingLevel: null,
  reviewModel: "",
  reviewThinkingLevel: null,
}

const PR_STATUS_CHECKS_POLL_DELAY = Duration.seconds(30)
/** Catch-up window after the latest Check-Start Anchor before startup is complete. */
export const CHECK_START_DEADLINE_MS = 90_000

/**
 * Settled non-failing PR Status Check outcomes that may skip a Ready-Phase
 * Status Check Round when waitForReadyForReviewChecks is disabled.
 */
const isSettledNonFailingPrStatus = (tag: string): boolean =>
  tag === "succeeded" || tag === "no_checks" || tag === "expected"

/**
 * SQLite may return 0/1 or boolean. Missing/null defaults to wait (safe).
 */
const decodeWaitForReadyForReviewChecks = (
  waitForReady: number | boolean | null | undefined,
): boolean => !(waitForReady === 0 || waitForReady === false)

/** Accept finite GitHub instants, including slight clock-skew futures. */
const validInstantMs = (value: Date | null): number | null => {
  if (value === null) {
    return null
  }
  const ms = value.getTime()
  if (!Number.isFinite(ms)) {
    return null
  }
  return ms
}

const lastPrChangeMs = (input: {
  readonly createdAt: Date | null
  readonly headPushedAt: Date | null
  readonly observedHeadAt: number | null
  readonly nowMs: number
}): number => {
  const createdMs = validInstantMs(input.createdAt)
  const pushedMs = validInstantMs(input.headPushedAt)
  const pushOrObserved = pushedMs ?? input.observedHeadAt
  if (createdMs !== null && pushOrObserved !== null) {
    return Math.max(createdMs, pushOrObserved)
  }
  if (pushOrObserved !== null) {
    return pushOrObserved
  }
  if (createdMs !== null) {
    return createdMs
  }
  return input.nowMs
}

const pollDelayUntilDeadline = (
  nowMs: number,
  deadlineMs: number,
): Duration.Duration => {
  const remaining = deadlineMs - nowMs
  if (remaining <= 0) {
    return PR_STATUS_CHECKS_POLL_DELAY
  }
  return Duration.millis(
    Math.min(Duration.toMillis(PR_STATUS_CHECKS_POLL_DELAY), remaining),
  )
}

const nextOperationalStep = (
  step: OperationalLifecycleStep,
): OperationalLifecycleStep | "complete" => {
  switch (step) {
    case "create_worktree":
      return "install_dependencies"
    case "install_dependencies":
      return "implement"
    case "implement":
      return "assess_changes"
    case "assess_changes":
      return "pre_commit"
    case "pre_commit":
      return "review"
    case "review":
      return "commit"
    case "commit":
      return "create_pr"
    case "create_pr":
      return "watch_pr_status_checks"
    case "watch_pr_status_checks":
      return "watch_pr_status_checks"
    case "resolve_pr_merge_conflict":
      return "watch_pr_status_checks"
    case "investigate_pr_status_checks":
      return "watch_pr_status_checks"
    case "mark_pr_ready_for_review":
      return "watch_pr_status_checks"
    case "decide_pr_merge":
      return "merge_pr"
    case "merge_pr":
      return "local_cleanup"
    case "close_issue":
      return "local_cleanup"
    case "local_cleanup":
      return "complete"
  }
}

export type ImplementNowError =
  | IssueNotFoundError
  | IssueNotOpenError
  | ParentIssueError
  | IssueBlockedError
  | UnfinishedWorkItemExistsError
  | BuildModelNotConfiguredError
  | AgentBackendUnavailableError
  | WorkItemLifecycleDatabaseError
  | RepositoryNotFoundError
  | DatabaseError
  | EnqueueError
  | InvalidQueueNameError

export type ImplementAllWithAutoMergeError =
  | IssueNotFoundError
  | NotAParentIssueError
  | UnsupportedIssueHierarchyError
  | ImplementAllWithAutoMergeNotEligibleError
  | BuildModelNotConfiguredError
  | AgentBackendUnavailableError
  | WorkItemLifecycleDatabaseError
  | RepositoryNotFoundError
  | DatabaseError
  | EnqueueError
  | InvalidQueueNameError

export type QueueError =
  | IssueNotFoundError
  | IssueNotOpenError
  | ParentIssueError
  | IssueNotBlockedError
  | UnfinishedWorkItemExistsError
  | BuildModelNotConfiguredError
  | AgentBackendUnavailableError
  | WorkItemLifecycleDatabaseError
  | RepositoryNotFoundError
  | DatabaseError

export type GetWorkItemError =
  | WorkItemNotFoundError
  | WorkItemLifecycleDatabaseError

export type ListWorkItemsError = WorkItemLifecycleDatabaseError

export type RunStepError =
  | StepRunNotFoundError
  | WorkItemNotFoundError
  | WorkItemLifecycleDatabaseError
  | EnqueueError
  | InvalidQueueNameError
  | AcknowledgeError
  | JobNotFoundError
  | RepositoryNotFoundError
  | DatabaseError

export type RetryError =
  | WorkItemNotFoundError
  | WorkItemTerminalError
  | ActiveStepRunExistsError
  | RetryNotEligibleError
  | WorkItemLifecycleDatabaseError
  | EnqueueError
  | InvalidQueueNameError

export type AbandonError =
  | WorkItemNotFoundError
  | WorkItemTerminalError
  | WorkItemHasRunningStepError
  | AbandonCleanupError
  | WorkItemLifecycleDatabaseError
  | AcknowledgeError
  | JobNotFoundError

export type HumanPrOutcome =
  | "merged"
  | "closed_unmerged"
  | "merge_conflict"
  | "merge_conflict_cleared"

export type ContinueAfterHumanPrOutcomeError =
  | WorkItemNotFoundError
  | NeedsHumanHandoffNotEligibleError
  | AbandonCleanupError
  | WorkItemLifecycleDatabaseError
  | EnqueueError
  | InvalidQueueNameError

export type ResetError =
  | WorkItemNotFoundError
  | ResetCleanupError
  | GitHubThrottledError
  | WorkItemLifecycleDatabaseError
  | AcknowledgeError
  | JobNotFoundError

export type PauseError =
  | WorkItemNotFoundError
  | WorkItemTerminalError
  | WorkItemWaitingForBlockersError
  | WorkItemLifecycleDatabaseError
  | AcknowledgeError
  | JobNotFoundError

export type StartError =
  | WorkItemNotFoundError
  | WorkItemTerminalError
  | WorkItemWaitingForBlockersError
  | WorkItemLifecycleDatabaseError
  | EnqueueError
  | InvalidQueueNameError
  | AcknowledgeError
  | JobNotFoundError

export type RunStepResult =
  | {
      readonly _tag: "processed"
      readonly workItem: WorkItemRecord
    }
  | {
      readonly _tag: "noop"
    }

export type WakePostponedStepResult =
  | { readonly _tag: "woke" }
  | { readonly _tag: "stale" }
  | { readonly _tag: "not_due" }

/**
 * One page of historical Completed Work Items (Complete / Abandoned, all repos).
 */
export type CompletedWorkItemsPage = {
  readonly items: readonly WorkItemRecord[]
  readonly page: number
  readonly pageSize: number
  readonly totalCount: number
}

export interface WorkItemLifecycleShape {
  readonly maxDurations: LifecycleMaxDurations
  readonly recoverOrphanedStepRuns: Effect.Effect<
    number,
    WorkItemLifecycleDatabaseError
  >
  /**
   * Process-epoch ownership: every Step Run still `running` from a prior
   * harness/job-worker process is Interrupted, slots released, queue jobs acked.
   * Call once before the job worker accepts new claims after startup.
   */
  readonly interruptRunningStepRunsFromPriorWorker: Effect.Effect<
    number,
    WorkItemLifecycleDatabaseError
  >
  readonly implementNow: (
    repositoryId: string,
    issueNumber: number,
  ) => Effect.Effect<WorkItemRecord, ImplementNowError>
  readonly implementLocally: (
    repositoryId: string,
    issueNumber: number,
  ) => Effect.Effect<WorkItemRecord, ImplementNowError>
  /**
   * Parent-level Implement all with auto-merge. Snapshots open direct Child
   * Issues and, atomically: creates ordinary Work Items with Merge Mode Always
   * for children without an unfinished Work Item (unblocked → Implement Now
   * admission; blocked → Queue / Waiting for blockers); sets Merge Mode Always
   * on each existing unfinished child Work Item without resetting lifecycle
   * state, history, admission, Session, worktree, or PR. A merge-related Needs
   * Human handoff stays stopped. No Parent Work Item.
   */
  readonly implementAllWithAutoMerge: (
    repositoryId: string,
    parentIssueNumber: number,
  ) => Effect.Effect<readonly WorkItemRecord[], ImplementAllWithAutoMergeError>
  /**
   * Queue a Relevant open leaf Issue that has listed blockers: creates a Work
   * Item in Waiting for blockers (no Worker Slot, no Step Run).
   */
  readonly queue: (
    repositoryId: string,
    issueNumber: number,
  ) => Effect.Effect<WorkItemRecord, QueueError>
  readonly runStep: (
    stepRunId: string,
  ) => Effect.Effect<RunStepResult, RunStepError>
  /**
   * Admit a due GitHub-throttle wake. A stale wake is harmless; a wake which
   * arrives before its persisted deadline is retained for redelivery.
   */
  readonly wakePostponedStep: (input: {
    readonly workItemId: WorkItemId
    readonly postponedUntil: number
  }) => Effect.Effect<WakePostponedStepResult, RunStepError>
  readonly retry: (
    workItemId: string,
  ) => Effect.Effect<WorkItemRecord, RetryError>
  readonly pause: (
    workItemId: string,
  ) => Effect.Effect<WorkItemRecord, PauseError>
  readonly start: (
    workItemId: string,
  ) => Effect.Effect<WorkItemRecord, StartError>
  readonly abandon: (
    workItemId: string,
  ) => Effect.Effect<WorkItemRecord, AbandonError>
  readonly reset: (workItemId: string) => Effect.Effect<WorkItemId, ResetError>
  readonly getWorkItem: (
    workItemId: string,
  ) => Effect.Effect<WorkItemRecord, GetWorkItemError>
  readonly listWorkItemsForIssue: (
    repositoryId: string,
    issueNumber: number,
  ) => Effect.Effect<readonly WorkItemRecord[], ListWorkItemsError>
  readonly listWorkItemsForRepository: (
    repositoryId: string,
  ) => Effect.Effect<readonly WorkItemRecord[], ListWorkItemsError>
  /**
   * Historical Completed Work Items across all repositories (Complete and
   * Abandoned only). No rolling 24-hour window. Ordered by stateReadyAt
   * newest-first with a stable rowid tie-break. Page is 1-based.
   */
  readonly listCompletedWorkItems: (options: {
    readonly page: number
    readonly pageSize: number
  }) => Effect.Effect<CompletedWorkItemsPage, ListWorkItemsError>
  /**
   * True when any Work Item (any state) has this OpenCode Session id.
   * Used to gate GraphQL session usage reads to harness-owned Sessions.
   */
  readonly ownsSessionId: (
    sessionId: string,
  ) => Effect.Effect<boolean, ListWorkItemsError>
  /**
   * Count unique Work Items with a non-null GitHub PR number and a successful
   * commit Step Run whose finished_at is in the half-open range [fromMs, toMs).
   */
  readonly countCommittedPullRequests: (
    fromMs: number,
    toMs: number,
  ) => Effect.Effect<number, ListWorkItemsError>
  /**
   * Advance after a confirmed Work Item PR outcome from Refresh.
   * `merged` supersedes any unfinished step (including Needs Human and Work
   * Items paused for closed Issue + open/indeterminate PR) that owns a Work
   * Item PR: interrupt/cancel active Step Runs, clear pause and operator
   * reason, re-acquire a Worker Slot (or wait if none free), then local
   * cleanup toward Complete. `closed_unmerged` Abandons Decide/Merge/Resolve
   * Needs Human handoffs. `merge_conflict` advances Decide/Merge Needs Human
   * to Resolve PR Merge Conflict; `merge_conflict_cleared` advances Resolve
   * Needs Human to Watch PR Status Checks. Both re-acquire a Worker Slot
   * (or wait if none free) like other Needs Human exits.
   */
  readonly continueAfterHumanPrOutcome: (
    workItemId: string,
    outcome: HumanPrOutcome,
  ) => Effect.Effect<WorkItemRecord, ContinueAfterHumanPrOutcomeError>
  /** Admit FIFO waiters up to the current maxConcurrentWorkItems bound. */
  readonly admitWaitingWorkItems: Effect.Effect<
    number,
    | WorkItemLifecycleDatabaseError
    | EnqueueError
    | InvalidQueueNameError
    | DatabaseError
  >
  /**
   * After Issue reconciliation for a Repository: revalidate Work Items Waiting
   * for blockers. Implementable Issues leave the hold and seek Worker Slot
   * admission (FIFO by creation time with other waiters). Still-blocked valid
   * open leaves stay held. Invalid candidates fail terminally. Repository
   * Paused does not block lift; path is full remote (no pause-before-step).
   */
  readonly releaseWaitingForBlockers: (
    repositoryId: string,
  ) => Effect.Effect<
    number,
    | WorkItemLifecycleDatabaseError
    | EnqueueError
    | InvalidQueueNameError
    | DatabaseError
    | RepositoryNotFoundError
  >
}

export class WorkItemLifecycle extends Context.Service<
  WorkItemLifecycle,
  WorkItemLifecycleShape
>()("@ready-for-agent/work-item-lifecycle/WorkItemLifecycle") {}

/** Operator-visible reason when Issue is closed/missing and PR is still open. */
export const formatIssueClosedWhilePrOpenMessage = (
  issueNumber: number,
  pullRequestNumber: number,
): string =>
  `Issue #${issueNumber} is closed or no longer present while pull request #${pullRequestNumber} is still open. Reopen the issue if you want to continue, then Start job.`

/**
 * Operator-visible reason when Issue is closed/missing and PR status is
 * indeterminate (lookup failed or PR not found). Same Pause policy as open PR.
 */
export const formatIssueClosedPrStatusIndeterminateMessage = (
  issueNumber: number,
  pullRequestNumber: number,
): string =>
  `Issue #${issueNumber} is closed or no longer present while pull request #${pullRequestNumber} appears still open or its status could not be confirmed. Reopen the issue if you want to continue, then Start job.`

/** Operator-visible reason when Issue is closed/missing and PR was closed unmerged. */
export const formatIssueClosedPrClosedUnmergedMessage = (
  issueNumber: number,
  pullRequestNumber: number,
): string =>
  `Issue #${issueNumber} is closed or no longer present and pull request #${pullRequestNumber} was closed without merge. Start job after reopening if you want to continue, or Abandon or Reset.`

/**
 * Step Run history reason when Issue revalidation finds the Issue closed/missing
 * and the owned Work Item PR is already merged — advances to local cleanup.
 */
export const formatIssueClosedPrMergedMessage = (
  issueNumber: number,
  pullRequestNumber: number,
): string =>
  `Issue #${issueNumber} is closed or no longer present and pull request #${pullRequestNumber} is merged; advancing to local cleanup`

export const makeWorkItemLifecycleLive = (
  config: WorkItemLifecycleConfig = {},
): Layer.Layer<
  WorkItemLifecycle,
  NonTransactionalQueueError,
  | SqlClient.SqlClient
  | DbService
  | QueueService
  | LifecycleSteps
  | ActiveAgentBackend
  | GitHubService
  | GitLabService
> =>
  Layer.effect(
    WorkItemLifecycle,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = yield* DbService
      const queue = yield* QueueService
      const steps = yield* LifecycleSteps
      const activeAgentBackend = yield* ActiveAgentBackend
      const github = yield* GitHubService
      const gitlab = yield* GitLabService
      /**
       * Resolve build/review models for a backend id (create: effective;
       * turns: captured). Uses repository flat columns (project effective)
       * then harness `backendModelPrefs` for that backend id.
       */
      const resolveModelsForBackend = (
        repositoryId: string,
        backendId: string,
      ): Effect.Effect<
        AgentModelSelection,
        BuildModelNotConfiguredError | DatabaseError
      > =>
        resolveAgentModelsForBackend(repositoryId, backendId).pipe(
          Effect.provideService(DbService, db),
        )
      const notifyWorkItemsChanged = (
        repositoryId: string,
      ): Effect.Effect<void> => db.notifyWorkItemsChanged(repositoryId)
      const maxDurations: LifecycleMaxDurations = {
        ...DEFAULT_LIFECYCLE_MAX_DURATIONS,
        ...config.maxDurations,
      }
      const activeStepExecutions = new Map<
        string,
        {
          readonly workItemId: string
          readonly cancel: Deferred.Deferred<void>
          readonly finished: Deferred.Deferred<void>
        }
      >()
      const resettingWorkItems = new Set<string>()
      /** Work Items being advanced to local cleanup because their PR merged. */
      const mergeSupersedingWorkItems = new Set<string>()

      if (!queue.queueInTransaction) {
        return yield* new NonTransactionalQueueError({
          message:
            "Work Item Lifecycle requires a QueueService that participates in database transactions",
        })
      }

      // Best-effort graceful shutdown: interrupt in-process Step Runs so dispose
      // does not leave durable `running` when the process exits cleanly.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const executions = [...activeStepExecutions.values()]
          if (executions.length === 0) {
            return
          }
          yield* Effect.forEach(
            executions,
            ({ cancel }) => Deferred.succeed(cancel, undefined),
            { discard: true },
          )
          yield* Effect.forEach(
            executions,
            ({ finished }) => Deferred.await(finished),
            { discard: true, concurrency: "unbounded" },
          )
        }),
      )

      const findUnfinishedWorkItemId = (
        repositoryId: string,
        issueNumber: number,
      ): Effect.Effect<string | null, WorkItemLifecycleDatabaseError> =>
        Effect.gen(function* () {
          const rows = (yield* sql
            .unsafe(
              `SELECT id FROM work_item
             WHERE repository_id = ?
               AND issue_number = ?
               AND state NOT IN ('complete', 'failed', 'abandoned')
             ORDER BY created_at ASC, rowid ASC
             LIMIT 1`,
              [repositoryId, issueNumber],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            id: string
          }[]
          return rows[0]?.id ?? null
        })

      const unfinishedWorkItemExistsError = (
        repositoryId: string,
        issueNumber: number,
        knownWorkItemId?: string,
      ): Effect.Effect<
        never,
        UnfinishedWorkItemExistsError | WorkItemLifecycleDatabaseError
      > =>
        Effect.gen(function* () {
          const workItemId =
            knownWorkItemId ??
            (yield* findUnfinishedWorkItemId(repositoryId, issueNumber))
          return yield* new UnfinishedWorkItemExistsError({
            repositoryId,
            issueNumber,
            workItemId: workItemId ?? "unknown",
          })
        })

      const loadStepRuns = (
        workItemIds: readonly string[],
        nowMs: number,
      ): Effect.Effect<
        Map<string, StepRunRecord[]>,
        WorkItemLifecycleDatabaseError
      > =>
        Effect.gen(function* () {
          const byWorkItem = new Map<string, StepRunRecord[]>()
          if (workItemIds.length === 0) {
            return byWorkItem
          }

          const placeholders = workItemIds.map(() => "?").join(", ")
          const rows = (yield* sql
            .unsafe(
              `SELECT ${STEP_RUN_SELECT_COLUMNS}
             FROM step_run
             WHERE work_item_id IN (${placeholders})
             ORDER BY queued_at ASC, rowid ASC`,
              [...workItemIds],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly StepRunRow[]

          for (const row of rows) {
            const record = toStepRunRecord(row, nowMs)
            const existing = byWorkItem.get(row.work_item_id)
            if (existing) {
              existing.push(record)
            } else {
              byWorkItem.set(row.work_item_id, [record])
            }
          }
          return byWorkItem
        })

      const getWorkItem = Effect.fn("WorkItemLifecycle.getWorkItem")(function* (
        workItemId: string,
      ) {
        const nowMs = yield* Clock.currentTimeMillis
        const rows = (yield* sql
          .unsafe(
            `SELECT ${WORK_ITEM_SELECT_COLUMNS}
           FROM work_item
           WHERE id = ?
           LIMIT 1`,
            [workItemId],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly WorkItemRow[]

        const row = rows[0]
        if (!row) {
          return yield* new WorkItemNotFoundError({ workItemId })
        }

        const stepRunsByWorkItem = yield* loadStepRuns([row.id], nowMs)
        return toWorkItemRecord(
          row,
          stepRunsByWorkItem.get(row.id) ?? [],
          nowMs,
        )
      })

      const listWorkItemsForIssue = Effect.fn(
        "WorkItemLifecycle.listWorkItemsForIssue",
      )(function* (repositoryId: string, issueNumber: number) {
        const nowMs = yield* Clock.currentTimeMillis
        const rows = (yield* sql
          .unsafe(
            `SELECT ${WORK_ITEM_SELECT_COLUMNS}
           FROM work_item
           WHERE repository_id = ? AND issue_number = ?
           ORDER BY created_at ASC, rowid ASC`,
            [repositoryId, issueNumber],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly WorkItemRow[]

        const stepRunsByWorkItem = yield* loadStepRuns(
          rows.map((row) => row.id),
          nowMs,
        )
        return rows.map((row) =>
          toWorkItemRecord(row, stepRunsByWorkItem.get(row.id) ?? [], nowMs),
        )
      })

      const listWorkItemsForRepository = Effect.fn(
        "WorkItemLifecycle.listWorkItemsForRepository",
      )(function* (repositoryId: string) {
        const nowMs = yield* Clock.currentTimeMillis
        const rows = (yield* sql
          .unsafe(
            `SELECT ${WORK_ITEM_SELECT_COLUMNS}
           FROM work_item
           WHERE repository_id = ?
           ORDER BY created_at ASC, rowid ASC`,
            [repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly WorkItemRow[]

        const stepRunsByWorkItem = yield* loadStepRuns(
          rows.map((row) => row.id),
          nowMs,
        )
        return rows.map((row) =>
          toWorkItemRecord(row, stepRunsByWorkItem.get(row.id) ?? [], nowMs),
        )
      })

      /**
       * Server-side pagination for historical Completed (no 24 h window).
       * Clamps page/pageSize the same way as GraphQL so direct callers cannot
       * request an unbounded LIMIT.
       */
      const listCompletedWorkItems = Effect.fn(
        "WorkItemLifecycle.listCompletedWorkItems",
      )(function* (options: {
        readonly page: number
        readonly pageSize: number
      }) {
        const page =
          !Number.isFinite(options.page) || options.page < 1
            ? 1
            : Math.max(1, Math.trunc(options.page))
        const pageSize =
          !Number.isFinite(options.pageSize) || options.pageSize < 1
            ? COMPLETED_WORK_ITEMS_DEFAULT_PAGE_SIZE
            : Math.min(
                COMPLETED_WORK_ITEMS_MAX_PAGE_SIZE,
                Math.trunc(options.pageSize),
              )
        const offset = (page - 1) * pageSize
        const nowMs = yield* Clock.currentTimeMillis

        const countRows = (yield* sql
          .unsafe(
            `SELECT COUNT(*) AS count
             FROM work_item
             WHERE state IN ('complete', 'abandoned')`,
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly {
          readonly count: number
        }[]
        const totalCount = Number(countRows[0]?.count ?? 0)

        const rows = (yield* sql
          .unsafe(
            `SELECT ${WORK_ITEM_SELECT_COLUMNS}
             FROM work_item
             WHERE state IN ('complete', 'abandoned')
             ORDER BY state_ready_at DESC, rowid DESC
             LIMIT ? OFFSET ?`,
            [pageSize, offset],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly WorkItemRow[]

        const stepRunsByWorkItem = yield* loadStepRuns(
          rows.map((row) => row.id),
          nowMs,
        )
        return {
          items: rows.map((row) =>
            toWorkItemRecord(row, stepRunsByWorkItem.get(row.id) ?? [], nowMs),
          ),
          page,
          pageSize,
          totalCount,
        } satisfies CompletedWorkItemsPage
      })

      const ownsSessionId = Effect.fn("WorkItemLifecycle.ownsSessionId")(
        function* (sessionId: string) {
          const rows = (yield* sql
            .unsafe(
              `SELECT 1 AS owned
               FROM work_item
               WHERE session_id = ?
               LIMIT 1`,
              [sessionId],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            readonly owned: number
          }[]
          return rows.length > 0
        },
      )

      const countCommittedPullRequests = Effect.fn(
        "WorkItemLifecycle.countCommittedPullRequests",
      )(function* (fromMs: number, toMs: number) {
        const rows = (yield* sql
          .unsafe(
            `SELECT COUNT(DISTINCT wi.id) AS count
             FROM work_item wi
             INNER JOIN step_run sr ON sr.work_item_id = wi.id
             WHERE wi.pull_request_number IS NOT NULL
               AND sr.step = 'commit'
               AND sr.status = 'succeeded'
               AND sr.finished_at IS NOT NULL
               AND sr.finished_at >= ?
               AND sr.finished_at < ?`,
            [fromMs, toMs],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly {
          readonly count: number
        }[]
        return Number(rows[0]?.count ?? 0)
      })

      const loadStepRunRow = (
        stepRunId: string,
      ): Effect.Effect<StepRunRow | null, WorkItemLifecycleDatabaseError> =>
        Effect.gen(function* () {
          const rows = (yield* sql
            .unsafe(
              `SELECT ${STEP_RUN_SELECT_COLUMNS}
              FROM step_run
              WHERE id = ?
              LIMIT 1`,
              [stepRunId],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly StepRunRow[]
          return rows[0] ?? null
        })

      const loadWorkItemRow = (
        workItemId: string,
      ): Effect.Effect<WorkItemRow | null, WorkItemLifecycleDatabaseError> =>
        Effect.gen(function* () {
          const rows = (yield* sql
            .unsafe(
              `SELECT ${WORK_ITEM_SELECT_COLUMNS}
             FROM work_item
             WHERE id = ?
             LIMIT 1`,
              [workItemId],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly WorkItemRow[]
          return rows[0] ?? null
        })

      /**
       * The single seam for applying a Work Item state transition.
       *
       * Callers run this inside the transaction containing `mutation`. The
       * relation is checked only after the persisted state reaches `to`, so a
       * rejected or no-op mutation is not reported as an applied transition.
       */
      const applyLifecycleTransition = <A, E, R>(
        workItemId: string,
        to: WorkItemState,
        mutation: Effect.Effect<A, E, R>,
        didApply: (result: A) => boolean,
      ): Effect.Effect<A, E | SqlError, R> =>
        applyCheckedLifecycleTransition(
          Effect.gen(function* () {
            const rows = (yield* sql.unsafe(
              `SELECT state FROM work_item WHERE id = ? LIMIT 1`,
              [workItemId],
            )) as readonly { readonly state: WorkItemState }[]
            return rows[0]?.state
          }),
          to,
          mutation,
          didApply,
        )

      const countOccupiedWorkerSlots = (): Effect.Effect<
        number,
        WorkItemLifecycleDatabaseError
      > =>
        Effect.gen(function* () {
          const rows = (yield* sql
            .unsafe(
              `SELECT COUNT(*) AS occupied
               FROM work_item
               WHERE holds_worker_slot = 1`,
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            readonly occupied: number
          }[]
          return Number(rows[0]?.occupied ?? 0)
        })

      const maxWorkerSlots = (): Effect.Effect<
        number,
        WorkItemLifecycleDatabaseError | DatabaseError
      > =>
        db.getConfig.pipe(
          Effect.map((config) => Math.max(1, config.maxConcurrentWorkItems)),
        )

      const encodeStepJob = (stepRunId: string) =>
        Schema.decodeUnknownEffect(WorkItemStepJob)({
          _tag: "work-item-step",
          stepRunId,
        }).pipe(
          Effect.mapError(
            (error) =>
              new WorkItemLifecycleDatabaseError({
                message: `Failed to encode work-item-step payload: ${String(error)}`,
                cause: error,
              }),
          ),
        )

      const encodeWakeJob = (workItemId: string, postponedUntil: number) =>
        Schema.decodeUnknownEffect(WorkItemWakeJob)({
          _tag: "work-item-wake",
          workItemId,
          postponedUntil,
        }).pipe(
          Effect.mapError(
            (error) =>
              new WorkItemLifecycleDatabaseError({
                message: `Failed to encode work-item-wake payload: ${String(error)}`,
                cause: error,
              }),
          ),
        )

      const enqueueStepRunForWorkItem = (
        workItemId: string,
        step: OperationalLifecycleStep,
        now: number,
        delay?: Duration.Duration,
      ): Effect.Effect<
        void,
        WorkItemLifecycleDatabaseError | EnqueueError | InvalidQueueNameError
      > =>
        Effect.gen(function* () {
          const nextStepRunId = makeStepRunId()
          yield* sql
            .unsafe(
              `INSERT INTO step_run (
               id, work_item_id, step, status, queue_job_id, queued_at,
               started_at, finished_at, reason_code, reason_message,
               created_at, updated_at
             ) VALUES (?, ?, ?, 'queued', NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
              [nextStepRunId, workItemId, step, now, now, now],
            )
            .pipe(Effect.mapError(toDatabaseError))
          const payload = yield* encodeStepJob(nextStepRunId)
          const enqueue =
            delay === undefined
              ? queue.enqueue(WORK_ITEM_LIFECYCLE_QUEUE, payload, {
                  retryLimit: 1,
                })
              : queue.enqueueWithDelay(
                  WORK_ITEM_LIFECYCLE_QUEUE,
                  payload,
                  delay,
                  { retryLimit: 1 },
                )
          const jobId = yield* enqueue
          yield* sql
            .unsafe(
              `UPDATE step_run
             SET queue_job_id = ?, updated_at = ?
             WHERE id = ?`,
              [jobId, now, nextStepRunId],
            )
            .pipe(Effect.mapError(toDatabaseError))
        })

      /**
       * Try to claim a free Worker Slot for this Work Item (must run in a txn).
       * Returns true if admitted (or already holding), false if marked waiting.
       */
      const tryAcquireWorkerSlot = (
        workItemId: string,
        now: number,
      ): Effect.Effect<
        boolean,
        WorkItemLifecycleDatabaseError | DatabaseError
      > =>
        Effect.gen(function* () {
          const current = yield* loadWorkItemRow(workItemId)
          if (!current) {
            return false
          }
          if (current.holds_worker_slot) {
            yield* sql
              .unsafe(
                `UPDATE work_item
               SET waiting_since = NULL, updated_at = ?
               WHERE id = ?`,
                [now, workItemId],
              )
              .pipe(Effect.mapError(toDatabaseError))
            return true
          }
          const limit = yield* maxWorkerSlots()
          const occupied = yield* countOccupiedWorkerSlots()
          if (occupied < limit) {
            yield* sql
              .unsafe(
                `UPDATE work_item
               SET holds_worker_slot = 1,
                   waiting_since = NULL,
                   updated_at = ?
               WHERE id = ?`,
                [now, workItemId],
              )
              .pipe(Effect.mapError(toDatabaseError))
            return true
          }
          yield* sql
            .unsafe(
              `UPDATE work_item
             SET holds_worker_slot = 0,
                 waiting_since = COALESCE(waiting_since, ?),
                 updated_at = ?
             WHERE id = ?`,
              [now, now, workItemId],
            )
            .pipe(Effect.mapError(toDatabaseError))
          return false
        })

      const admitWaitingWorkItems = Effect.gen(function* () {
        let admitted = 0
        // Loop: re-read config and occupancy each admission.
        for (;;) {
          const limit = yield* maxWorkerSlots()
          const occupied = yield* countOccupiedWorkerSlots()
          if (occupied >= limit) {
            break
          }
          const free = limit - occupied
          const waiters = (yield* sql
            .unsafe(
              `SELECT id, state FROM work_item
               WHERE waiting_since IS NOT NULL
                 AND holds_worker_slot = 0
                 AND paused = 0
                 AND state NOT IN ('complete', 'failed', 'abandoned')
               ORDER BY waiting_since ASC, created_at ASC, rowid ASC
               LIMIT ?`,
              [free],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            readonly id: string
            readonly state: WorkItemState
          }[]
          if (waiters.length === 0) {
            break
          }

          const now = yield* Clock.currentTimeMillis
          for (const waiter of waiters) {
            const stillFree =
              (yield* countOccupiedWorkerSlots()) < (yield* maxWorkerSlots())
            if (!stillFree) {
              break
            }
            if (
              isTerminalWorkItemState(waiter.state) &&
              waiter.state !== "needs_human"
            ) {
              continue
            }

            // Needs Human waiters re-acquire for abandon cleanup via abandon()
            // / Refresh; only operational waiters get a Step Run here.
            if (waiter.state === "needs_human") {
              continue
            }

            const pendingStep = waiter.state as OperationalLifecycleStep
            const didAdmit = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const acquired = yield* tryAcquireWorkerSlot(waiter.id, now)
                  if (!acquired) {
                    return false
                  }
                  const activeRows = (yield* sql.unsafe(
                    `SELECT id FROM step_run
                     WHERE work_item_id = ?
                       AND status IN ('queued', 'running')
                     LIMIT 1`,
                    [waiter.id],
                  )) as readonly { readonly id: string }[]
                  if (activeRows[0]) {
                    return true
                  }
                  yield* enqueueStepRunForWorkItem(waiter.id, pendingStep, now)
                  return true
                }),
              )
              .pipe(
                Effect.catch((error) => {
                  if (
                    error instanceof WorkItemLifecycleDatabaseError ||
                    error instanceof EnqueueError ||
                    error instanceof InvalidQueueNameError
                  ) {
                    return Effect.fail(error)
                  }
                  if (
                    typeof error === "object" &&
                    error !== null &&
                    "_tag" in error &&
                    (error as { _tag: string })._tag === "SqlError"
                  ) {
                    return Effect.fail(toDatabaseError(error as SqlError))
                  }
                  return Effect.fail(
                    new WorkItemLifecycleDatabaseError({
                      message: `Failed admitting waiter: ${String(error)}`,
                      cause: error,
                    }),
                  )
                }),
              )
            if (didAdmit) {
              admitted += 1
              const row = yield* loadWorkItemRow(waiter.id)
              if (row) {
                yield* notifyWorkItemsChanged(row.repository_id)
              }
            }
          }
          if (waiters.length < free) {
            break
          }
        }
        return admitted
      })

      /**
       * Classify a held (Waiting for blockers) Work Item's Issue after
       * reconciliation. Still-blocked valid open leaves stay held — that is
       * not terminal. Mid-flight revalidation uses revalidateIssue instead.
       * Callers load the Issue store once per release pass and pass it in.
       */
      type HeldIssueClassification =
        | { readonly _tag: "still_blocked" }
        | { readonly _tag: "implementable" }
        | {
            readonly _tag: "invalid"
            readonly failureCode: string
            readonly failureMessage: string
          }

      const classifyHeldIssue = (
        issues: readonly {
          readonly issueNumber: number
          readonly state: string
          readonly hasChildren: boolean
          readonly blockedBy: readonly unknown[]
        }[],
        issueNumber: number,
      ): HeldIssueClassification => {
        const issue = issues.find(
          (candidate) => candidate.issueNumber === issueNumber,
        )
        const verdict = evaluateImplementableIssue(
          currentIssuePredicateInput(issue),
        )
        switch (verdict._tag) {
          case "match":
            return { _tag: "implementable" }
          case "issue_blocked":
            return { _tag: "still_blocked" }
          case "issue_missing":
            return {
              _tag: "invalid",
              failureCode: "issue_not_found",
              failureMessage: `Issue #${issueNumber} is no longer present in the Issue store`,
            }
          case "issue_not_open":
            return {
              _tag: "invalid",
              failureCode: "issue_not_open",
              failureMessage: `Issue #${issueNumber} is ${verdict.state}, not OPEN`,
            }
          case "issue_not_leaf":
            return {
              _tag: "invalid",
              failureCode: "issue_is_parent",
              failureMessage: `Issue #${issueNumber} has children and is no longer a Leaf Issue`,
            }
        }
      }

      const releaseWaitingForBlockers = Effect.fn(
        "WorkItemLifecycle.releaseWaitingForBlockers",
      )(function* (repositoryId: string) {
        // Creation order so free slots go to oldest held items first when
        // several become Implementable together.
        const heldRows = (yield* sql
          .unsafe(
            `SELECT ${WORK_ITEM_SELECT_COLUMNS}
             FROM work_item
             WHERE repository_id = ?
               AND waiting_for_blockers = 1
               AND state NOT IN ('complete', 'failed', 'abandoned')
             ORDER BY created_at ASC, rowid ASC`,
            [repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly WorkItemRow[]

        if (heldRows.length === 0) {
          return 0
        }

        // One Issue-store snapshot per refresh release pass (not per held row).
        const issues = yield* db.listIssues(repositoryId)
        let changed = 0

        for (const held of heldRows) {
          // Per-item isolation: one release failure must not abort the rest of
          // the repository pass (or skip post-reconcile Issue notification).
          // Matches syncNeedsHumanMergeHandoffs. Next refresh retries leftovers.
          const didChange = yield* Effect.gen(function* () {
            const classification = classifyHeldIssue(issues, held.issue_number)

            if (classification._tag === "still_blocked") {
              return false
            }

            const now = yield* Clock.currentTimeMillis

            if (classification._tag === "invalid") {
              const failedRows = (yield* sql
                .withTransaction(
                  applyLifecycleTransition(
                    held.id,
                    "failed",
                    sql
                      .unsafe(
                        `UPDATE work_item
                   SET state = 'failed',
                       state_ready_at = ?,
                       failure_code = ?,
                       failure_message = ?,
                       holds_worker_slot = 0,
                       waiting_since = NULL,
                       waiting_for_blockers = 0,
                       updated_at = ?
                   WHERE id = ?
                     AND waiting_for_blockers = 1
                     AND state NOT IN ('complete', 'failed', 'abandoned')
                   RETURNING id`,
                        [
                          now,
                          classification.failureCode,
                          classification.failureMessage,
                          now,
                          held.id,
                        ],
                      )
                      .pipe(
                        Effect.map(
                          (rows) => rows as readonly { readonly id: string }[],
                        ),
                      ),
                    (rows) => rows.length > 0,
                  ),
                )
                .pipe(Effect.mapError(toDatabaseError))) as readonly {
                readonly id: string
              }[]
              return Boolean(failedRows[0])
            }

            // Implementable: clear hold and admit like a fresh Implement Now
            // (full remote path — pause_before_step stays null from Queue).
            return yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const current = yield* loadWorkItemRow(held.id)
                  if (
                    !current?.waiting_for_blockers ||
                    isTerminalWorkItemState(current.state)
                  ) {
                    return false
                  }

                  // Leave Waiting for blockers before admission so the row is
                  // eligible for Worker Slot wait / Step Run enqueue. RETURNING
                  // gates concurrent abandon/reset that already left the hold.
                  const clearedRows = (yield* sql
                    .unsafe(
                      `UPDATE work_item
                       SET waiting_for_blockers = 0,
                           updated_at = ?
                       WHERE id = ?
                         AND waiting_for_blockers = 1
                         AND state NOT IN ('complete', 'failed', 'abandoned')
                       RETURNING id, state, created_at`,
                      [now, held.id],
                    )
                    .pipe(Effect.mapError(toDatabaseError))) as readonly {
                    readonly id: string
                    readonly state: WorkItemState
                    readonly created_at: number
                  }[]
                  const cleared = clearedRows[0]
                  if (!cleared) {
                    return false
                  }

                  const limit = yield* maxWorkerSlots()
                  const occupied = yield* countOccupiedWorkerSlots()
                  if (occupied < limit) {
                    yield* sql
                      .unsafe(
                        `UPDATE work_item
                         SET holds_worker_slot = 1,
                             waiting_since = NULL,
                             updated_at = ?
                         WHERE id = ?
                           AND waiting_for_blockers = 0
                           AND state NOT IN ('complete', 'failed', 'abandoned')`,
                        [now, held.id],
                      )
                      .pipe(Effect.mapError(toDatabaseError))
                    const pendingStep =
                      cleared.state as OperationalLifecycleStep
                    const activeRows = (yield* sql.unsafe(
                      `SELECT id FROM step_run
                       WHERE work_item_id = ?
                         AND status IN ('queued', 'running')
                       LIMIT 1`,
                      [held.id],
                    )) as readonly { readonly id: string }[]
                    if (!activeRows[0]) {
                      yield* enqueueStepRunForWorkItem(
                        held.id,
                        pendingStep,
                        now,
                      )
                    }
                  } else {
                    // FIFO with other Worker Slot waiters by creation time when
                    // never previously admitted (CONTEXT: Waiting for Worker Slot).
                    yield* sql
                      .unsafe(
                        `UPDATE work_item
                         SET holds_worker_slot = 0,
                             waiting_since = ?,
                             updated_at = ?
                         WHERE id = ?
                           AND waiting_for_blockers = 0
                           AND state NOT IN ('complete', 'failed', 'abandoned')`,
                        [cleared.created_at, now, held.id],
                      )
                      .pipe(Effect.mapError(toDatabaseError))
                  }
                  return true
                }),
              )
              .pipe(
                Effect.catch((error) => {
                  if (
                    error instanceof WorkItemLifecycleDatabaseError ||
                    error instanceof EnqueueError ||
                    error instanceof InvalidQueueNameError
                  ) {
                    return Effect.fail(error)
                  }
                  if (
                    typeof error === "object" &&
                    error !== null &&
                    "_tag" in error &&
                    (error as { _tag: string })._tag === "SqlError"
                  ) {
                    return Effect.fail(toDatabaseError(error as SqlError))
                  }
                  return Effect.fail(
                    new WorkItemLifecycleDatabaseError({
                      message: `Failed releasing Waiting for blockers Work Item: ${String(error)}`,
                      cause: error,
                    }),
                  )
                }),
              )
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "Failed releasing Waiting for blockers Work Item; continuing pass",
                {
                  workItemId: held.id,
                  repositoryId,
                  error: String(error),
                },
              ).pipe(Effect.as(false)),
            ),
          )

          if (didChange) {
            changed += 1
            yield* notifyWorkItemsChanged(repositoryId)
          }
        }

        return changed
      })

      const revalidateIssue = (
        repositoryId: string,
        issueNumber: number,
      ): Effect.Effect<
        | { readonly ok: true }
        | {
            readonly ok: false
            readonly failureCode: string
            readonly failureMessage: string
          },
        RepositoryNotFoundError | DatabaseError
      > =>
        Effect.gen(function* () {
          const issues = yield* db.listIssues(repositoryId)
          const issue = issues.find(
            (candidate) => candidate.issueNumber === issueNumber,
          )
          const verdict = evaluateImplementableIssue(
            currentIssuePredicateInput(issue),
          )
          switch (verdict._tag) {
            case "match":
              return { ok: true as const }
            case "issue_missing":
              return {
                ok: false as const,
                failureCode: "issue_not_found",
                failureMessage: `Issue #${issueNumber} is no longer present in the Issue store`,
              }
            case "issue_not_open":
              return {
                ok: false as const,
                failureCode: "issue_not_open",
                failureMessage: `Issue #${issueNumber} is ${verdict.state}, not OPEN`,
              }
            case "issue_not_leaf":
              return {
                ok: false as const,
                failureCode: "issue_is_parent",
                failureMessage: `Issue #${issueNumber} has children and is no longer a Leaf Issue`,
              }
            case "issue_blocked":
              return {
                ok: false as const,
                failureCode: "issue_blocked",
                failureMessage: `Issue #${issueNumber} is blocked by ${verdict.blockerCount} Issue(s)`,
              }
          }
        })

      const mergeRevalidationCount = (
        workItemId: string,
      ): Effect.Effect<number, WorkItemLifecycleDatabaseError> =>
        Effect.gen(function* () {
          const rows = (yield* sql
            .unsafe(
              `SELECT COUNT(*) AS count FROM step_run
               WHERE work_item_id = ?
                 AND step = 'merge_pr'
                 AND status = 'succeeded'
                 AND reason_code = ?`,
              [workItemId, STEP_RUN_REASON.mergeRevalidation],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            readonly count: number
          }[]
          return Number(rows[0]?.count ?? 0)
        })

      /**
       * Live Repository waitForReadyForReviewChecks policy. Missing row → true.
       */
      const loadWaitForReadyForReviewChecks = (
        repositoryId: string,
      ): Effect.Effect<boolean, WorkItemLifecycleDatabaseError> =>
        Effect.gen(function* () {
          const rows = (yield* sql
            .unsafe(
              `SELECT wait_for_ready_for_review_checks AS wait_for_ready
               FROM repository WHERE id = ?`,
              [repositoryId],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            readonly wait_for_ready: number | boolean | null
          }[]
          return decodeWaitForReadyForReviewChecks(rows[0]?.wait_for_ready)
        })

      const runHandler = (
        step: OperationalLifecycleStep,
        context: LifecycleStepContext,
        workItem: WorkItemRow,
      ): Effect.Effect<
        {
          readonly worktreePath?: string | null
          readonly startingCommitOid?: string | null
          readonly completionSummary?: string | null
          readonly publicationTitle?: string | null
          readonly publicationBody?: string | null
          readonly pauseBeforeStep?: OperationalLifecycleStep | null
          readonly sessionId?: string
          readonly pullRequestNumber?: number
          readonly handledCheckIds?: readonly string[]
          readonly refreshCheckStartAnchor?: boolean
          readonly checkStartLastObservedIsDraft?: number | null
          readonly stepRunReasonCode?: StepRunReasonCode
          readonly stepRunNote?: string
          readonly transition?: {
            readonly nextState:
              | OperationalLifecycleStep
              | "complete"
              | "needs_human"
            readonly delay?: Duration.Duration
            readonly reason?: string
          }
        },
        RunHandlerError
      > => {
        switch (step) {
          case "create_worktree":
            return steps.createWorktree(context).pipe(
              Effect.map((result) => ({
                worktreePath: result.worktreePath,
                startingCommitOid: result.startingCommitOid,
              })),
            )
          case "install_dependencies":
            return steps.installDependencies(context).pipe(Effect.as({}))
          case "implement":
            return steps
              .implement(context)
              .pipe(Effect.map((sessionId) => ({ sessionId })))
          case "assess_changes":
            return steps.assessChanges(context).pipe(
              Effect.map((result) =>
                result._tag === "changes"
                  ? {}
                  : {
                      completionSummary: result.completionSummary,
                      pauseBeforeStep:
                        workItem.pause_before_step === "commit"
                          ? ("close_issue" as const)
                          : undefined,
                      transition: {
                        nextState: "close_issue" as const,
                      },
                    },
              ),
            )
          case "pre_commit":
            return steps.preCommit(context).pipe(Effect.as({}))
          case "review":
            return steps.review(context).pipe(
              Effect.map((result) => {
                if (result._tag === "deferred") {
                  return {
                    stepRunReasonCode: STEP_RUN_REASON.reviewDeferred,
                    stepRunNote: formatDeferredReviewSummary(
                      result.severity,
                      result.reason,
                    ),
                  }
                }
                if (result._tag === "cleared") {
                  return {
                    stepRunReasonCode: STEP_RUN_REASON.reviewCleared,
                    stepRunNote: result.reason,
                  }
                }
                if (result._tag === "accepted") {
                  return {
                    stepRunReasonCode: STEP_RUN_REASON.reviewAccepted,
                    stepRunNote: formatAcceptedReviewSummary(
                      result.reason,
                      result.deferred,
                    ),
                  }
                }
                if (result._tag === "needs_human") {
                  return {
                    transition: {
                      nextState: "needs_human" as const,
                      reason: result.reason,
                    },
                  }
                }
                return {}
              }),
            )
          case "commit":
            return steps.commit(context).pipe(
              Effect.map((result) => ({
                publicationTitle: result.publicationTitle,
                publicationBody: result.publicationBody,
                stepRunReasonCode:
                  result.completion === "native"
                    ? STEP_RUN_REASON.native
                    : STEP_RUN_REASON.agentFallback,
              })),
            )
          case "create_pr":
            return steps.createPr(context).pipe(
              Effect.map((result) => ({
                pullRequestNumber: result.pullRequestNumber,
                // Hard-persist copy used this step (includes HEAD seed).
                publicationTitle: result.publicationTitle,
                publicationBody: result.publicationBody,
                // Create PR opens a draft; persist so an external ready before
                // the first Watch poll still gets a ready-phase anchor.
                checkStartLastObservedIsDraft: 1,
                stepRunReasonCode:
                  result.completion === "native"
                    ? STEP_RUN_REASON.native
                    : STEP_RUN_REASON.agentFallback,
              })),
            )
          case "watch_pr_status_checks":
            return steps.watchPrStatusChecks(context).pipe(
              Effect.flatMap((status) =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis
                  const waitForReadyForReviewChecks =
                    yield* loadWaitForReadyForReviewChecks(
                      workItem.repository_id,
                    )
                  const rawHeadSha =
                    "headSha" in status ? (status.headSha ?? null) : null
                  const headSha =
                    typeof rawHeadSha === "string" && rawHeadSha.trim() !== ""
                      ? rawHeadSha
                      : null
                  const createdAt =
                    "createdAt" in status ? (status.createdAt ?? null) : null
                  const headPushedAt =
                    "headPushedAt" in status
                      ? (status.headPushedAt ?? null)
                      : null
                  const observedIsDraft =
                    "isDraft" in status ? (status.isDraft ?? null) : null
                  // Unknown draft status is neither draft nor ready; do not
                  // Mark Ready or Decide until GitHub reports a boolean.
                  const isDraft = observedIsDraft === true
                  const isReady = observedIsDraft === false
                  let observedHeadSha = workItem.check_start_observed_head_sha
                  let observedHeadAt = workItem.check_start_observed_head_at
                  const pushedMs = validInstantMs(headPushedAt)
                  if (headSha !== null) {
                    if (observedHeadSha !== headSha) {
                      observedHeadSha = headSha
                      // First-observation fallback only when GitHub omits a
                      // valid push time for this head.
                      observedHeadAt = pushedMs === null ? now : null
                    } else if (pushedMs !== null) {
                      // Authoritative push evidence supersedes any earlier
                      // observation fallback for the same head.
                      observedHeadAt = null
                    }
                  } else if (
                    observedHeadSha !== null &&
                    workItem.check_start_anchor_head_sha !== null &&
                    observedHeadSha !== workItem.check_start_anchor_head_sha
                  ) {
                    observedHeadSha = null
                    observedHeadAt = null
                  }

                  const lastChange = lastPrChangeMs({
                    createdAt,
                    headPushedAt,
                    observedHeadAt: pushedMs === null ? observedHeadAt : null,
                    nowMs: now,
                  })

                  let anchorAt = workItem.check_start_anchor_at
                  let anchorHeadSha = workItem.check_start_anchor_head_sha
                  const headChanged =
                    headSha !== null &&
                    anchorHeadSha !== null &&
                    headSha !== anchorHeadSha
                  if (headChanged) {
                    // Replacement head must not inherit the prior head's anchor.
                    anchorAt = lastChange
                    anchorHeadSha = headSha
                  } else if (anchorAt === null) {
                    anchorAt = lastChange
                    if (headSha !== null) {
                      anchorHeadSha = headSha
                    }
                  } else {
                    // Keep a conservative persisted anchor (e.g. migration
                    // backfill); only move it forward for newer Last PR Change.
                    if (lastChange > anchorAt) {
                      anchorAt = lastChange
                    }
                    if (headSha !== null && anchorHeadSha === null) {
                      anchorHeadSha = headSha
                    }
                  }

                  // External draft→ready is a Check-Start Anchor by default.
                  // When waitForReadyForReviewChecks is disabled, only a failed
                  // aggregate forces a Ready-Phase round (recovery may start);
                  // settled non-failing may Decide immediately, and pending
                  // continues without a new ready-phase anchor (matches Mark Ready).
                  const previouslyDraft =
                    workItem.check_start_last_observed_is_draft === 1
                  const knownDraftToReady =
                    previouslyDraft && !isDraft && observedIsDraft === false
                  const skipReadyPhaseStartupWait =
                    !waitForReadyForReviewChecks &&
                    knownDraftToReady &&
                    isSettledNonFailingPrStatus(status._tag)
                  const forceReadyPhaseAnchor =
                    knownDraftToReady &&
                    (waitForReadyForReviewChecks || status._tag === "failed")
                  if (forceReadyPhaseAnchor) {
                    if (anchorAt === null || now > anchorAt) {
                      anchorAt = now
                    }
                  }

                  const lastObservedIsDraft =
                    observedIsDraft === null
                      ? workItem.check_start_last_observed_is_draft
                      : observedIsDraft
                        ? 1
                        : 0

                  yield* sql
                    .unsafe(
                      `UPDATE work_item
                       SET check_start_anchor_at = ?,
                           check_start_anchor_head_sha = ?,
                           check_start_observed_head_sha = ?,
                           check_start_observed_head_at = ?,
                           check_start_last_observed_is_draft = ?,
                           updated_at = ?
                       WHERE id = ?`,
                      [
                        anchorAt,
                        anchorHeadSha,
                        observedHeadSha,
                        observedHeadAt,
                        lastObservedIsDraft,
                        now,
                        workItem.id,
                      ],
                    )
                    .pipe(Effect.mapError(toDatabaseError))

                  const deadlineMs = (anchorAt ?? now) + CHECK_START_DEADLINE_MS
                  const pastDeadline = now >= deadlineMs
                  const requeueDelay = pollDelayUntilDeadline(now, deadlineMs)

                  if (status._tag === "conflict") {
                    return {
                      handledCheckIds: status.retiredCheckIds,
                      transition: {
                        nextState: "resolve_pr_merge_conflict" as const,
                      },
                    }
                  }
                  if (status._tag === "handoff_needed") {
                    return {
                      transition: {
                        nextState: "investigate_pr_status_checks" as const,
                      },
                    }
                  }
                  if (status._tag === "closed") {
                    return {
                      transition: {
                        nextState: "needs_human" as const,
                        reason:
                          "The pull request was closed before its status checks succeeded",
                      },
                    }
                  }
                  // Actual pending executions and unknown mergeability keep polling.
                  if (status._tag === "pending") {
                    return {
                      transition: {
                        nextState: "watch_pr_status_checks" as const,
                        delay: pastDeadline
                          ? PR_STATUS_CHECKS_POLL_DELAY
                          : requeueDelay,
                      },
                    }
                  }
                  if (status._tag === "failed") {
                    // Draft with no unhandled terminals and known mergeability
                    // still advances to Mark Ready; the ready-phase window can
                    // restart checks. Ready PRs fail retryably at the deadline.
                    if (isDraft) {
                      return {
                        transition: {
                          nextState: "mark_pr_ready_for_review" as const,
                        },
                      }
                    }
                    if (!isReady || !pastDeadline) {
                      return {
                        transition: {
                          nextState: "watch_pr_status_checks" as const,
                          delay: pastDeadline
                            ? PR_STATUS_CHECKS_POLL_DELAY
                            : requeueDelay,
                        },
                      }
                    }
                    return yield* new PrStatusChecksUnresolvedError({
                      message:
                        "Manual fixing may be required. Status checks remained failed without a new check execution to investigate. Please fix or rerun the checks on the pull request, then click Retry checks.",
                    })
                  }
                  // Settled: no_checks, expected, and all-terminal success.
                  if (
                    status._tag === "no_checks" ||
                    status._tag === "expected" ||
                    status._tag === "succeeded"
                  ) {
                    // Draft skips the catch-up window and advances to Mark Ready.
                    if (isDraft) {
                      return {
                        transition: {
                          nextState: "mark_pr_ready_for_review" as const,
                        },
                      }
                    }
                    // Unknown draft status: keep polling until GitHub reports it.
                    if (!isReady) {
                      return {
                        transition: {
                          nextState: "watch_pr_status_checks" as const,
                          delay: pastDeadline
                            ? PR_STATUS_CHECKS_POLL_DELAY
                            : requeueDelay,
                        },
                      }
                    }
                    // Known draft→ready with opt-out: reuse settled draft evidence.
                    if (skipReadyPhaseStartupWait) {
                      return {
                        transition: {
                          nextState: nextStateAfterReadyForMerge(
                            workItem.merge_mode,
                          ),
                        },
                      }
                    }
                    // Ready phase waits for the Check-Start Deadline, then Decide
                    // (or Merge PR when Merge Mode is Always).
                    if (!pastDeadline) {
                      return {
                        transition: {
                          nextState: "watch_pr_status_checks" as const,
                          delay: requeueDelay,
                        },
                      }
                    }
                    return {
                      transition: {
                        nextState: nextStateAfterReadyForMerge(
                          workItem.merge_mode,
                        ),
                      },
                    }
                  }
                  return {
                    transition: {
                      nextState: isDraft
                        ? ("mark_pr_ready_for_review" as const)
                        : isReady
                          ? nextStateAfterReadyForMerge(workItem.merge_mode)
                          : ("watch_pr_status_checks" as const),
                    },
                  }
                }),
              ),
            )
          case "resolve_pr_merge_conflict":
            return steps.resolvePrMergeConflict(context).pipe(
              Effect.map((result) => ({
                transition:
                  result._tag === "processed"
                    ? {
                        nextState: "watch_pr_status_checks" as const,
                        delay: PR_STATUS_CHECKS_POLL_DELAY,
                      }
                    : {
                        nextState: "needs_human" as const,
                        reason: result.reason,
                      },
              })),
            )
          case "investigate_pr_status_checks":
            return steps.investigatePrStatusChecks(context).pipe(
              Effect.map((result) => {
                if (result._tag === "checks_triggered") {
                  return {
                    handledCheckIds: result.handledCheckIds,
                    // Do not overwrite an anchor already recorded at the
                    // trigger event (authorized review rerun API success).
                    refreshCheckStartAnchor: !result.checkStartAnchorRecorded,
                    transition: {
                      nextState: "watch_pr_status_checks" as const,
                      delay: PR_STATUS_CHECKS_POLL_DELAY,
                    },
                  }
                }
                if (result._tag === "processed") {
                  return {
                    handledCheckIds: result.handledCheckIds,
                    stepRunReasonCode: result.reasonCode,
                    stepRunNote: result.reasonNote,
                    transition: {
                      nextState: "watch_pr_status_checks" as const,
                    },
                  }
                }
                return {
                  handledCheckIds: result.handledCheckIds,
                  transition: {
                    nextState: "needs_human" as const,
                    reason: result.reason,
                  },
                }
              }),
            )
          case "mark_pr_ready_for_review":
            return steps.markPrReadyForReview(context).pipe(
              Effect.flatMap(() =>
                Effect.gen(function* () {
                  const waitForReadyForReviewChecks =
                    yield* loadWaitForReadyForReviewChecks(
                      workItem.repository_id,
                    )

                  if (waitForReadyForReviewChecks) {
                    return {
                      // Fresh ready-phase Check-Start Anchor; return to Watch so
                      // ready_for_review workflows get the full catch-up window.
                      refreshCheckStartAnchor: true,
                      checkStartLastObservedIsDraft: 0 as const,
                      transition: {
                        nextState: "watch_pr_status_checks" as const,
                      },
                    }
                  }

                  // Setting disabled: re-observe after ready. Only skip the
                  // Ready-Phase round when checks are settled and non-failing.
                  const status = yield* steps.watchPrStatusChecks(context)
                  if (status._tag === "conflict") {
                    return {
                      handledCheckIds: status.retiredCheckIds,
                      checkStartLastObservedIsDraft: 0 as const,
                      transition: {
                        nextState: "resolve_pr_merge_conflict" as const,
                      },
                    }
                  }
                  if (status._tag === "handoff_needed") {
                    return {
                      checkStartLastObservedIsDraft: 0 as const,
                      transition: {
                        nextState: "investigate_pr_status_checks" as const,
                      },
                    }
                  }
                  if (status._tag === "closed") {
                    return {
                      checkStartLastObservedIsDraft: 0 as const,
                      transition: {
                        nextState: "needs_human" as const,
                        reason:
                          "The pull request was closed before its status checks succeeded",
                      },
                    }
                  }
                  if (isSettledNonFailingPrStatus(status._tag)) {
                    return {
                      checkStartLastObservedIsDraft: 0 as const,
                      transition: {
                        nextState: nextStateAfterReadyForMerge(
                          workItem.merge_mode,
                        ),
                      },
                    }
                  }
                  // Failed aggregate forces a Ready-Phase round so recovery may
                  // start. Pending is not short-cut to Decide and continues
                  // watching without a new ready-phase anchor.
                  return {
                    refreshCheckStartAnchor: status._tag === "failed",
                    checkStartLastObservedIsDraft: 0 as const,
                    transition: {
                      nextState: "watch_pr_status_checks" as const,
                    },
                  }
                }),
              ),
            )
          case "decide_pr_merge":
            // Defensive: Always should never enter this step; if it does, skip
            // the agent risk decision and advance to Merge PR.
            if (decodeMergeMode(workItem.merge_mode) === "always") {
              return Effect.succeed({
                transition: { nextState: "merge_pr" as const },
              })
            }
            return steps.decidePrMerge(context).pipe(
              Effect.map((result) =>
                result._tag === "clanker_merge"
                  ? {}
                  : {
                      transition: {
                        nextState: "needs_human" as const,
                        reason: result.reason,
                      },
                    },
              ),
            )
          case "merge_pr":
            return steps.mergePr(context).pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  if (result._tag === "merged") {
                    return {}
                  }
                  if (result._tag === "needs_human") {
                    return {
                      transition: {
                        nextState: "needs_human" as const,
                        reason: result.message,
                      },
                    }
                  }
                  const priorOutcomes = yield* mergeRevalidationCount(
                    workItem.id,
                  )
                  const outcomeNumber = priorOutcomes + 1
                  return {
                    stepRunReasonCode: STEP_RUN_REASON.mergeRevalidation,
                    stepRunNote: result.message,
                    transition:
                      outcomeNumber <= 3
                        ? {
                            nextState: "watch_pr_status_checks" as const,
                          }
                        : {
                            nextState: "needs_human" as const,
                            reason:
                              "Merge revalidation requires human intervention after four changed merge attempts",
                          },
                  }
                }),
              ),
            )
          case "close_issue":
            return steps.closeIssue(context).pipe(Effect.as({}))
          case "local_cleanup":
            return steps
              .localCleanup(context)
              .pipe(Effect.as({ worktreePath: null }))
        }
      }

      const catchTransactionError = <A>(
        error: unknown,
      ): Effect.Effect<A, RunStepError> => {
        if (error instanceof WorkItemLifecycleDatabaseError) {
          return Effect.fail(error)
        }
        if (error instanceof EnqueueError) {
          return Effect.fail(error)
        }
        if (error instanceof InvalidQueueNameError) {
          return Effect.fail(error)
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          (error as { _tag: string })._tag === "SqlError"
        ) {
          return Effect.fail(toDatabaseError(error as SqlError))
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          ((error as { _tag: string })._tag === "AcknowledgeError" ||
            (error as { _tag: string })._tag === "JobNotFoundError")
        ) {
          return Effect.fail(error as AcknowledgeError | JobNotFoundError)
        }
        return Effect.fail(
          new WorkItemLifecycleDatabaseError({
            message: `Unexpected transaction failure: ${String(error)}`,
            cause: error,
          }),
        )
      }

      /**
       * When Issue revalidation fails only with issue_not_open / issue_not_found
       * and a Work Item PR is owned, inspect PR lifecycle to decide stop shape.
       * Lookup failures fail closed to a visible open-PR pause (never silent park).
       */
      const inspectOwnedPrLifecycleStatus = (
        row: WorkItemRow,
      ): Effect.Effect<
        PullRequestLifecycleStatus | null,
        GitHubThrottledError
      > =>
        Effect.gen(function* () {
          const repositories = yield* db.listRepositories
          const repository = repositories.find(
            (candidate) => candidate.id === row.repository_id,
          )
          if (repository === undefined) {
            return null
          }
          const headRefName = workItemBranchName({
            projectPath: repository.projectPath,
            issueNumber: row.issue_number,
            workItemId: row.id,
          })
          if (repository.forge === "gitlab") {
            return yield* gitlab.getPullRequestLifecycleStatus(
              repository,
              headRefName,
            )
          }
          if (repository.forge !== "github") {
            return null
          }
          return yield* github.getPullRequestLifecycleStatus(
            repository,
            headRefName,
          )
        }).pipe(
          Effect.catch((error) =>
            isGitHubThrottledError(error)
              ? Effect.fail(error)
              : Effect.logWarning(
                  "Owned-PR lifecycle lookup failed after Issue revalidation; failing closed to pause",
                  {
                    workItemId: row.id,
                    error: String(error),
                  },
                ).pipe(Effect.as(null)),
          ),
        )

      type OwnedPrIssueStop =
        | {
            readonly _tag: "merged"
            readonly reasonCode: StepRunReasonCode
            readonly reasonMessage: string
          }
        | {
            readonly _tag: "pause"
            readonly reasonCode: StepRunReasonCode
            readonly reasonMessage: string
          }

      const resolveOwnedPrIssueStop = (
        row: WorkItemRow,
        pullRequestNumber: number,
      ): Effect.Effect<OwnedPrIssueStop, GitHubThrottledError> =>
        Effect.gen(function* () {
          const status = yield* inspectOwnedPrLifecycleStatus(row)
          if (status !== null && status._tag === "merged") {
            return {
              _tag: "merged" as const,
              reasonCode: STEP_RUN_REASON.prMerged,
              reasonMessage: formatIssueClosedPrMergedMessage(
                row.issue_number,
                pullRequestNumber,
              ),
            }
          }
          if (status !== null && status._tag === "closed") {
            return {
              _tag: "pause" as const,
              reasonCode: STEP_RUN_REASON.issueClosedPrClosedUnmerged,
              reasonMessage: formatIssueClosedPrClosedUnmergedMessage(
                row.issue_number,
                pullRequestNumber,
              ),
            }
          }
          if (status !== null && status._tag === "open") {
            return {
              _tag: "pause" as const,
              reasonCode: STEP_RUN_REASON.issueClosedWhilePrOpen,
              reasonMessage: formatIssueClosedWhilePrOpenMessage(
                row.issue_number,
                pullRequestNumber,
              ),
            }
          }
          // not_found or lookup failed → pause (fail closed, never silent park)
          return {
            _tag: "pause" as const,
            reasonCode: STEP_RUN_REASON.issueClosedWhilePrOpen,
            reasonMessage: formatIssueClosedPrStatusIndeterminateMessage(
              row.issue_number,
              pullRequestNumber,
            ),
          }
        })

      const completeSuccessfulStep = (input: {
        readonly stepRun: StepRunRow
        readonly workItem: WorkItemRow
        readonly output: {
          readonly worktreePath?: string | null
          readonly startingCommitOid?: string | null
          readonly completionSummary?: string | null
          readonly publicationTitle?: string | null
          readonly publicationBody?: string | null
          readonly pauseBeforeStep?: OperationalLifecycleStep | null
          readonly sessionId?: string
          readonly pullRequestNumber?: number
          readonly handledCheckIds?: readonly string[]
          readonly refreshCheckStartAnchor?: boolean
          readonly checkStartLastObservedIsDraft?: number | null
          readonly stepRunReasonCode?: StepRunReasonCode
          readonly stepRunNote?: string
          readonly transition?: {
            readonly nextState:
              | OperationalLifecycleStep
              | "complete"
              | "needs_human"
            readonly delay?: Duration.Duration
            readonly reason?: string
          }
        }
        readonly revalidation:
          | { readonly ok: true }
          | {
              readonly ok: false
              readonly failureCode: string
              readonly failureMessage: string
            }
      }): Effect.Effect<WorkItemRecord, RunStepError | GitHubThrottledError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const { stepRun, workItem, output, revalidation } = input
          const transition = output.transition
          const worktreePath =
            output.worktreePath === undefined
              ? workItem.worktree_path
              : output.worktreePath
          const startingCommitOid =
            output.startingCommitOid === undefined
              ? workItem.starting_commit_oid
              : output.startingCommitOid
          const completionSummary =
            output.completionSummary === undefined
              ? workItem.completion_summary
              : output.completionSummary
          const publicationTitle =
            output.publicationTitle === undefined
              ? workItem.publication_title
              : output.publicationTitle
          const publicationBody =
            output.publicationBody === undefined
              ? workItem.publication_body
              : output.publicationBody
          const sessionId = output.sessionId ?? workItem.session_id
          const pullRequestNumber =
            output.pullRequestNumber ?? workItem.pull_request_number

          // A merged Work Item PR often closes the Issue. Do not Failed the Work
          // Item for issue_not_open / issue_not_found when a PR is already owned;
          // branch on PR lifecycle (open → Pause, merged → cleanup, closed → Pause).
          const deferIssueRevalidationForOwnedPr =
            !revalidation.ok &&
            pullRequestNumber !== null &&
            (revalidation.failureCode === "issue_not_found" ||
              revalidation.failureCode === "issue_not_open")
          const ownedPrIssueStop = deferIssueRevalidationForOwnedPr
            ? yield* resolveOwnedPrIssueStop(workItem, pullRequestNumber)
            : null
          const nextStep =
            transition?.nextState ?? nextOperationalStep(stepRun.step)
          // Assess Changes NO_CHANGES intentionally routes to Close Issue, which
          // accepts already-closed Issues. When the agent closed the Issue during
          // Implement (tracker/decision work), post-step revalidation sees
          // issue_not_open — allow that transition only; missing/blocked/parent
          // still fail terminally.
          const allowClosedIssueForNoChangeClose =
            !revalidation.ok &&
            revalidation.failureCode === "issue_not_open" &&
            stepRun.step === "assess_changes" &&
            transition?.nextState === "close_issue"
          const revalidationBlocksProgress =
            !revalidation.ok && !allowClosedIssueForNoChangeClose
          const stepRunReasonCode =
            ownedPrIssueStop?.reasonCode ?? output.stepRunReasonCode ?? null
          const stepRunReasonMessage =
            ownedPrIssueStop?.reasonMessage ?? output.stepRunNote ?? null
          const appliedNextState =
            ownedPrIssueStop?._tag === "merged"
              ? ("local_cleanup" as const)
              : ownedPrIssueStop?._tag === "pause"
                ? null
                : revalidationBlocksProgress
                  ? ("failed" as const)
                  : nextStep

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(
                  `UPDATE step_run
                 SET status = 'succeeded',
                     finished_at = ?,
                     reason_code = ?,
                     reason_message = ?,
                     updated_at = ?
                  WHERE id = ? AND status = 'running'`,
                  [
                    now,
                    stepRunReasonCode,
                    stepRunReasonMessage,
                    now,
                    stepRun.id,
                  ],
                )

                for (const checkId of output.handledCheckIds ?? []) {
                  yield* sql.unsafe(
                    `UPDATE pr_status_check
                       SET handled_at = ?, handled_by_step_run_id = ?, updated_at = ?
                       WHERE id = ? AND work_item_id = ? AND handled_at IS NULL`,
                    [now, stepRun.id, now, checkId, workItem.id],
                  )
                }

                if (
                  output.refreshCheckStartAnchor === true ||
                  output.checkStartLastObservedIsDraft !== undefined
                ) {
                  // Clearing the head binding with a fresh anchor prevents a
                  // later head change from replacing the ready-phase instant
                  // with an older Last PR Change timestamp.
                  yield* sql.unsafe(
                    `UPDATE work_item
                     SET check_start_anchor_at = CASE
                           WHEN ? = 1 THEN ?
                           ELSE check_start_anchor_at
                         END,
                         check_start_anchor_head_sha = CASE
                           WHEN ? = 1 THEN NULL
                           ELSE check_start_anchor_head_sha
                         END,
                         check_start_last_observed_is_draft = CASE
                           WHEN ? = 1 THEN ?
                           ELSE check_start_last_observed_is_draft
                         END,
                         updated_at = ?
                     WHERE id = ?`,
                    [
                      output.refreshCheckStartAnchor === true ? 1 : 0,
                      now,
                      output.refreshCheckStartAnchor === true ? 1 : 0,
                      output.checkStartLastObservedIsDraft !== undefined
                        ? 1
                        : 0,
                      output.checkStartLastObservedIsDraft ?? null,
                      now,
                      workItem.id,
                    ],
                  )
                }

                if (ownedPrIssueStop?._tag === "merged") {
                  // Confirmed merge at revalidation seam: same destination as
                  // Refresh / continueAfterHumanPrOutcome (local cleanup).
                  yield* sql.unsafe(
                    `UPDATE work_item
                   SET state = 'local_cleanup',
                       state_ready_at = ?,
                       paused = 0,
                       failure_code = NULL,
                       failure_message = NULL,
                       worktree_path = ?,
                       starting_commit_oid = ?,
                       completion_summary = ?,
                       publication_title = ?,
                       publication_body = ?,
                       session_id = ?,
                       pull_request_number = ?,
                       waiting_since = NULL,
                       waiting_for_blockers = 0,
                       updated_at = ?
                   WHERE id = ?`,
                    [
                      now,
                      worktreePath,
                      startingCommitOid,
                      completionSummary,
                      publicationTitle,
                      publicationBody,
                      sessionId,
                      pullRequestNumber,
                      now,
                      workItem.id,
                    ],
                  )
                  const acquired = yield* tryAcquireWorkerSlot(workItem.id, now)
                  if (acquired) {
                    yield* enqueueStepRunForWorkItem(
                      workItem.id,
                      "local_cleanup",
                      now,
                    )
                  }
                } else if (ownedPrIssueStop?._tag === "pause") {
                  // Pause Work Item: keep current operational state, release
                  // slot, no next step. Operator Start resumes after reopen.
                  // waiting_for_blockers cannot apply on this seam (blocked
                  // Issues fail revalidation without owned-PR deferral) but
                  // clear it for symmetry with merged/failed paths.
                  yield* sql.unsafe(
                    `UPDATE work_item
                   SET paused = 1,
                       failure_code = NULL,
                       failure_message = ?,
                       worktree_path = ?,
                       starting_commit_oid = ?,
                       completion_summary = ?,
                       publication_title = ?,
                       publication_body = ?,
                       session_id = ?,
                       pull_request_number = ?,
                       holds_worker_slot = 0,
                       waiting_since = NULL,
                       waiting_for_blockers = 0,
                       updated_at = ?
                   WHERE id = ?`,
                    [
                      ownedPrIssueStop.reasonMessage,
                      worktreePath,
                      startingCommitOid,
                      completionSummary,
                      publicationTitle,
                      publicationBody,
                      sessionId,
                      pullRequestNumber,
                      now,
                      workItem.id,
                    ],
                  )
                } else if (revalidationBlocksProgress) {
                  yield* sql.unsafe(
                    `UPDATE work_item
                   SET state = 'failed',
                       state_ready_at = ?,
                       failure_code = ?,
                       failure_message = ?,
                        worktree_path = ?,
                        starting_commit_oid = ?,
                        completion_summary = ?,
                        publication_title = ?,
                        publication_body = ?,
                        session_id = ?,
                        pull_request_number = ?,
                        holds_worker_slot = 0,
                        waiting_since = NULL,
                        waiting_for_blockers = 0,
                        updated_at = ?
                   WHERE id = ?`,
                    [
                      now,
                      revalidation.failureCode,
                      revalidation.failureMessage,
                      worktreePath,
                      startingCommitOid,
                      completionSummary,
                      publicationTitle,
                      publicationBody,
                      sessionId,
                      pullRequestNumber,
                      now,
                      workItem.id,
                    ],
                  )
                } else if (nextStep === "complete") {
                  yield* sql.unsafe(
                    `UPDATE work_item
                   SET state = 'complete',
                       state_ready_at = ?,
                        worktree_path = ?,
                        starting_commit_oid = ?,
                        completion_summary = ?,
                        publication_title = ?,
                        publication_body = ?,
                        session_id = ?,
                        pull_request_number = ?,
                        holds_worker_slot = 0,
                        waiting_since = NULL,
                        waiting_for_blockers = 0,
                        updated_at = ?
                   WHERE id = ?`,
                    [
                      now,
                      worktreePath,
                      startingCommitOid,
                      completionSummary,
                      publicationTitle,
                      publicationBody,
                      sessionId,
                      pullRequestNumber,
                      now,
                      workItem.id,
                    ],
                  )
                } else if (nextStep === "needs_human") {
                  yield* sql.unsafe(
                    `UPDATE work_item
                   SET state = 'needs_human',
                       state_ready_at = ?,
                       failure_code = 'needs_human',
                       failure_message = ?,
                        worktree_path = ?,
                        starting_commit_oid = ?,
                        completion_summary = ?,
                        publication_title = ?,
                        publication_body = ?,
                        session_id = ?,
                        pull_request_number = ?,
                        holds_worker_slot = 0,
                        waiting_since = NULL,
                        waiting_for_blockers = 0,
                        updated_at = ?
                   WHERE id = ?`,
                    [
                      now,
                      transition?.reason ??
                        `${agentBackendLabel(workItem.agent_backend)} requested human intervention`,
                      worktreePath,
                      startingCommitOid,
                      completionSummary,
                      publicationTitle,
                      publicationBody,
                      sessionId,
                      pullRequestNumber,
                      now,
                      workItem.id,
                    ],
                  )
                } else {
                  const stateReadyAt =
                    nextStep === workItem.state ? workItem.state_ready_at : now
                  // Re-read: Pause may land while this Step Run was draining.
                  const pausedRows = (yield* sql.unsafe(
                    `SELECT paused, pause_before_step FROM work_item WHERE id = ? LIMIT 1`,
                    [workItem.id],
                  )) as readonly {
                    readonly paused: boolean | number
                    readonly pause_before_step: OperationalLifecycleStep | null
                  }[]
                  const isPaused = Boolean(pausedRows[0]?.paused)
                  const currentPauseBefore =
                    pausedRows[0]?.pause_before_step ?? null
                  const pauseBeforeStep =
                    output.pauseBeforeStep === undefined
                      ? currentPauseBefore
                      : output.pauseBeforeStep
                  const shouldPauseBeforeNext =
                    pauseBeforeStep !== null && pauseBeforeStep === nextStep
                  // Do not clear operator Pause; only set paused when auto-pausing.
                  const stayPaused = isPaused || shouldPauseBeforeNext

                  if (shouldPauseBeforeNext) {
                    yield* sql.unsafe(
                      `UPDATE work_item
                   SET state = ?,
                       state_ready_at = ?,
                       paused = 1,
                       holds_worker_slot = 0,
                       waiting_since = NULL,
                        pause_before_step = ?,
                        worktree_path = ?,
                        starting_commit_oid = ?,
                        completion_summary = ?,
                        publication_title = ?,
                        publication_body = ?,
                        session_id = ?,
                        pull_request_number = ?,
                        updated_at = ?
                   WHERE id = ?`,
                      [
                        nextStep,
                        stateReadyAt,
                        pauseBeforeStep,
                        worktreePath,
                        startingCommitOid,
                        completionSummary,
                        publicationTitle,
                        publicationBody,
                        sessionId,
                        pullRequestNumber,
                        now,
                        workItem.id,
                      ],
                    )
                  } else if (stayPaused) {
                    // Operator Pause while Step Run was draining: release slot.
                    yield* sql.unsafe(
                      `UPDATE work_item
                   SET state = ?,
                       state_ready_at = ?,
                       holds_worker_slot = 0,
                       waiting_since = NULL,
                        pause_before_step = ?,
                        worktree_path = ?,
                        starting_commit_oid = ?,
                        completion_summary = ?,
                        publication_title = ?,
                        publication_body = ?,
                        session_id = ?,
                        pull_request_number = ?,
                        updated_at = ?
                   WHERE id = ?`,
                      [
                        nextStep,
                        stateReadyAt,
                        pauseBeforeStep,
                        worktreePath,
                        startingCommitOid,
                        completionSummary,
                        publicationTitle,
                        publicationBody,
                        sessionId,
                        pullRequestNumber,
                        now,
                        workItem.id,
                      ],
                    )
                  } else {
                    yield* sql.unsafe(
                      `UPDATE work_item
                   SET state = ?,
                       state_ready_at = ?,
                        pause_before_step = ?,
                        worktree_path = ?,
                        starting_commit_oid = ?,
                        completion_summary = ?,
                        publication_title = ?,
                        publication_body = ?,
                        session_id = ?,
                        pull_request_number = ?,
                        updated_at = ?
                   WHERE id = ?`,
                      [
                        nextStep,
                        stateReadyAt,
                        pauseBeforeStep,
                        worktreePath,
                        startingCommitOid,
                        completionSummary,
                        publicationTitle,
                        publicationBody,
                        sessionId,
                        pullRequestNumber,
                        now,
                        workItem.id,
                      ],
                    )
                  }

                  if (!stayPaused) {
                    yield* enqueueStepRunForWorkItem(
                      workItem.id,
                      nextStep,
                      now,
                      transition?.delay,
                    )
                  }
                }

                if (stepRun.queue_job_id !== null) {
                  yield* queue.acknowledge(stepRun.queue_job_id)
                }
              }).pipe((mutation) =>
                appliedNextState === null
                  ? mutation
                  : applyLifecycleTransition(
                      workItem.id,
                      appliedNextState,
                      mutation,
                      () => true,
                    ),
              ),
            )
            .pipe(Effect.catch(catchTransactionError))

          const completed = yield* getWorkItem(workItem.id).pipe(
            Effect.catchTag(
              "WorkItemNotFoundError",
              (error) =>
                new WorkItemLifecycleDatabaseError({
                  message: `Work Item missing after step completion: ${error.workItemId}`,
                  cause: error,
                }),
            ),
          )
          yield* notifyWorkItemsChanged(workItem.repository_id)
          if (!completed.holdsWorkerSlot) {
            yield* admitWaitingWorkItems.pipe(
              Effect.catch((error) =>
                Effect.logError(
                  "Failed to admit waiters after step completion",
                  {
                    error: String(error),
                  },
                ),
              ),
            )
          }
          return completed
        })

      const completeFailedStep = (input: {
        readonly stepRun: StepRunRow
        readonly workItem: WorkItemRow
        readonly reasonCode: string
        readonly reasonMessage: string
        readonly cause: Cause.Cause<unknown>
        readonly terminalFailure?: {
          readonly failureCode: string
          readonly failureMessage: string
        }
      }): Effect.Effect<WorkItemRecord, RunStepError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const {
            stepRun,
            workItem,
            reasonCode,
            reasonMessage,
            terminalFailure,
          } = input

          yield* Effect.logError("Lifecycle Step handler failed", {
            workItemId: workItem.id,
            stepRunId: stepRun.id,
            step: stepRun.step,
            reasonCode,
            reasonMessage,
            terminal: terminalFailure !== undefined,
          })

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(
                  `UPDATE step_run
                 SET status = 'failed',
                     finished_at = ?,
                     reason_code = ?,
                     reason_message = ?,
                     updated_at = ?
                 WHERE id = ? AND status = 'running'`,
                  [now, reasonCode, reasonMessage, now, stepRun.id],
                )

                if (terminalFailure !== undefined) {
                  yield* sql.unsafe(
                    `UPDATE work_item
                   SET state = 'failed',
                       state_ready_at = ?,
                       failure_code = ?,
                       failure_message = ?,
                       holds_worker_slot = 0,
                       waiting_since = NULL,
                       waiting_for_blockers = 0,
                       updated_at = ?
                   WHERE id = ?`,
                    [
                      now,
                      terminalFailure.failureCode,
                      terminalFailure.failureMessage,
                      now,
                      workItem.id,
                    ],
                  )
                } else {
                  yield* sql.unsafe(
                    `UPDATE work_item
                   SET holds_worker_slot = 0,
                       waiting_since = NULL,
                       updated_at = ?
                   WHERE id = ?`,
                    [now, workItem.id],
                  )
                }

                if (stepRun.queue_job_id !== null) {
                  yield* queue.fail(stepRun.queue_job_id, {
                    retryable: false,
                  })
                }
              }).pipe((mutation) =>
                terminalFailure === undefined
                  ? mutation
                  : applyLifecycleTransition(
                      workItem.id,
                      "failed",
                      mutation,
                      () => true,
                    ),
              ),
            )
            .pipe(Effect.catch(catchTransactionError))

          const failed = yield* getWorkItem(workItem.id).pipe(
            Effect.catchTag(
              "WorkItemNotFoundError",
              (error) =>
                new WorkItemLifecycleDatabaseError({
                  message: `Work Item missing after step failure: ${error.workItemId}`,
                  cause: error,
                }),
            ),
          )
          yield* notifyWorkItemsChanged(workItem.repository_id)
          yield* admitWaitingWorkItems.pipe(
            Effect.catch((error) =>
              Effect.logError("Failed to admit waiters after step failure", {
                error: String(error),
              }),
            ),
          )
          return failed
        })

      /**
       * A GitHub throttle is a finished, non-failing lifecycle attempt. The
       * wake is deliberately a queue job rather than a queued Step Run so the
       * derived Waiting for GitHub hold owns neither a Worker Slot nor active
       * execution history.
       */
      const completePostponedStep = (input: {
        readonly stepRun: StepRunRow
        readonly workItem: WorkItemRow
        readonly retryAt: number
      }): Effect.Effect<WorkItemRecord, RunStepError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const { stepRun, workItem, retryAt } = input
          const wakeDelay = Duration.millis(Math.max(0, retryAt - now))

          yield* Effect.logWarning("Postponing Lifecycle Step for GitHub", {
            workItemId: workItem.id,
            stepRunId: stepRun.id,
            step: stepRun.step,
            retryAt,
          })

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const postponedRows = yield* sql
                  .unsafe(
                    `UPDATE step_run
                   SET status = 'postponed',
                       finished_at = ?,
                       reason_code = ?,
                       reason_message = ?,
                       postponed_until = ?,
                       updated_at = ?
                   WHERE id = ? AND status = 'running'
                   RETURNING id`,
                    [
                      now,
                      STEP_RUN_REASON.githubThrottled,
                      `GitHub throttled until ${new Date(retryAt).toISOString()}`,
                      retryAt,
                      now,
                      stepRun.id,
                    ],
                  )
                  .pipe(Effect.flatMap(decodePostponedStepRunIdRows))
                if (!postponedRows[0]) {
                  return
                }

                yield* sql.unsafe(
                  `UPDATE work_item
                   SET holds_worker_slot = 0,
                       waiting_since = NULL,
                       updated_at = ?
                   WHERE id = ?`,
                  [now, workItem.id],
                )

                const wakePayload = yield* encodeWakeJob(workItem.id, retryAt)
                yield* queue.enqueueWithDelay(
                  WORK_ITEM_LIFECYCLE_QUEUE,
                  wakePayload,
                  wakeDelay,
                  { retryLimit: 1 },
                )

                if (stepRun.queue_job_id !== null) {
                  yield* queue.acknowledge(stepRun.queue_job_id)
                }
              }),
            )
            .pipe(Effect.catch(catchTransactionError))

          const postponed = yield* getWorkItem(workItem.id).pipe(
            Effect.catchTag(
              "WorkItemNotFoundError",
              (error) =>
                new WorkItemLifecycleDatabaseError({
                  message: `Work Item missing after postponement: ${error.workItemId}`,
                  cause: error,
                }),
            ),
          )
          yield* notifyWorkItemsChanged(workItem.repository_id)
          yield* admitWaitingWorkItems.pipe(
            Effect.catch((error) =>
              Effect.logError(
                "Failed to admit waiters after GitHub postponement",
                {
                  workItemId: workItem.id,
                  stepRunId: stepRun.id,
                  retryAt,
                  error: String(error),
                },
              ),
            ),
          )
          return postponed
        })

      const completeInterruptedStep = (input: {
        readonly stepRun: StepRunRow
        readonly reasonMessage: string
        readonly cause?: Cause.Cause<unknown>
      }): Effect.Effect<void, RunStepError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const { stepRun, reasonMessage } = input

          yield* Effect.logWarning("Lifecycle Step interrupted", {
            workItemId: stepRun.work_item_id,
            stepRunId: stepRun.id,
            step: stepRun.step,
            reasonMessage,
          })

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(
                  `UPDATE step_run
                 SET status = 'interrupted',
                     finished_at = ?,
                     reason_code = ?,
                     reason_message = ?,
                     updated_at = ?
                 WHERE id = ? AND status = 'running'`,
                  [
                    now,
                    STEP_RUN_REASON.interrupted,
                    reasonMessage,
                    now,
                    stepRun.id,
                  ],
                )

                yield* sql.unsafe(
                  `UPDATE work_item
                   SET holds_worker_slot = 0,
                       waiting_since = NULL,
                       updated_at = ?
                   WHERE id = ?`,
                  [now, stepRun.work_item_id],
                )

                if (stepRun.queue_job_id !== null) {
                  yield* queue
                    .acknowledge(stepRun.queue_job_id)
                    .pipe(
                      Effect.catchTag("JobNotFoundError", () => Effect.void),
                    )
                }
              }),
            )
            .pipe(Effect.catch(catchTransactionError))

          yield* admitWaitingWorkItems.pipe(
            Effect.catch((error) =>
              Effect.logError("Failed to admit waiters after interrupt", {
                error: String(error),
              }),
            ),
          )

          const workItem = yield* loadWorkItemRow(stepRun.work_item_id)
          if (workItem) {
            yield* notifyWorkItemsChanged(workItem.repository_id)
          }
        })

      const acknowledgeStaleDelivery = (
        stepRun: StepRunRow,
      ): Effect.Effect<void, RunStepError> =>
        Effect.gen(function* () {
          if (stepRun.queue_job_id === null) {
            return
          }
          yield* queue.acknowledge(stepRun.queue_job_id).pipe(
            Effect.catchTag("JobNotFoundError", () => Effect.void),
            Effect.mapError((error): RunStepError => error),
          )
        })

      const interruptSelectedRunningStepRuns = (input: {
        readonly reasonCode: StepRunReasonCode
        readonly reasonMessage: string
        readonly selectSql: string
        readonly selectParams: readonly unknown[]
      }): Effect.Effect<number, WorkItemLifecycleDatabaseError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const candidates = (yield* sql
            .unsafe(input.selectSql, [...input.selectParams])
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            readonly id: string
            readonly work_item_id: string
            readonly queue_job_id: string | null
            readonly repository_id: string
          }[]

          if (candidates.length === 0) {
            return 0
          }

          const interrupted: {
            readonly workItemId: string
            readonly repositoryId: string
          }[] = []

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                for (const row of candidates) {
                  const updated = (yield* sql.unsafe(
                    `UPDATE step_run
                     SET status = 'interrupted',
                         finished_at = ?,
                         reason_code = ?,
                         reason_message = ?,
                         updated_at = ?
                     WHERE id = ? AND status = 'running'
                     RETURNING id`,
                    [now, input.reasonCode, input.reasonMessage, now, row.id],
                  )) as readonly { readonly id: string }[]
                  if (updated.length === 0) {
                    continue
                  }

                  yield* sql.unsafe(
                    `UPDATE work_item
                     SET holds_worker_slot = 0,
                         waiting_since = NULL,
                         updated_at = ?
                     WHERE id = ?`,
                    [now, row.work_item_id],
                  )

                  if (row.queue_job_id !== null) {
                    yield* queue
                      .acknowledge(row.queue_job_id)
                      .pipe(
                        Effect.catchTag("JobNotFoundError", () => Effect.void),
                      )
                  }

                  interrupted.push({
                    workItemId: row.work_item_id,
                    repositoryId: row.repository_id,
                  })
                }
              }),
            )
            .pipe(
              Effect.catch((error) =>
                catchTransactionError(error).pipe(
                  Effect.mapError(
                    (mapped): WorkItemLifecycleDatabaseError =>
                      mapped instanceof WorkItemLifecycleDatabaseError
                        ? mapped
                        : new WorkItemLifecycleDatabaseError({
                            message: `Failed to interrupt running Step Runs: ${String(mapped)}`,
                            cause: mapped,
                          }),
                  ),
                ),
              ),
            )

          if (interrupted.length === 0) {
            return 0
          }

          yield* admitWaitingWorkItems.pipe(
            Effect.catch((error) =>
              Effect.logError(
                "Failed to admit waiters after interrupting Step Runs",
                { error: String(error) },
              ),
            ),
          )

          const repositoryIds = new Set(
            interrupted.map((row) => row.repositoryId),
          )
          yield* Effect.forEach(
            [...repositoryIds],
            (repositoryId) => notifyWorkItemsChanged(repositoryId),
            { discard: true },
          )

          return interrupted.length
        })

      const recoverOrphanedStepRuns = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        return yield* interruptSelectedRunningStepRuns({
          reasonCode: STEP_RUN_REASON.interrupted,
          reasonMessage: "Lifecycle Step lost its queue delivery",
          selectSql: `SELECT step_run.id,
                             step_run.work_item_id,
                             step_run.queue_job_id,
                             work_item.repository_id
                      FROM step_run
                      INNER JOIN work_item ON work_item.id = step_run.work_item_id
                      WHERE step_run.status = 'running'
                        AND (
                          step_run.queue_job_id IS NULL
                          OR NOT EXISTS (
                            SELECT 1 FROM job_queue
                            WHERE job_queue.id = step_run.queue_job_id
                          )
                          OR EXISTS (
                            SELECT 1 FROM job_queue
                            WHERE job_queue.id = step_run.queue_job_id
                              AND job_queue.job_attempts >= job_queue.job_retry_limit
                              AND (
                                job_queue.locked_until IS NULL
                                OR job_queue.locked_until <= ?
                              )
                          )
                        )`,
          selectParams: [now],
        })
      })

      const interruptRunningStepRunsFromPriorWorker =
        interruptSelectedRunningStepRuns({
          reasonCode: STEP_RUN_REASON.workerRestarted,
          reasonMessage:
            "Harness job worker stopped or restarted while the Step Run was still Running",
          selectSql: `SELECT step_run.id,
                             step_run.work_item_id,
                             step_run.queue_job_id,
                             work_item.repository_id
                      FROM step_run
                      INNER JOIN work_item ON work_item.id = step_run.work_item_id
                      WHERE step_run.status = 'running'`,
          selectParams: [],
        })

      const wakePostponedStep = Effect.fn(
        "WorkItemLifecycle.wakePostponedStep",
      )(function* ({
        workItemId,
        postponedUntil,
      }: {
        readonly workItemId: WorkItemId
        readonly postponedUntil: number
      }) {
        const preAdmissionNow = yield* Clock.currentTimeMillis
        const latestBeforeAdmission = yield* sql
          .unsafe(
            `SELECT step, status, postponed_until
           FROM step_run
           WHERE work_item_id = ?
           ORDER BY queued_at DESC, rowid DESC
           LIMIT 1`,
            [workItemId],
          )
          .pipe(
            Effect.mapError(toDatabaseError),
            Effect.flatMap(decodeLatestStepRunStatusRows),
          )
        const beforeAdmission = latestBeforeAdmission[0]
        if (
          beforeAdmission?.status !== "postponed" ||
          beforeAdmission.postponed_until !== postponedUntil
        ) {
          return { _tag: "stale" as const }
        }
        if (postponedUntil > preAdmissionNow) {
          return { _tag: "not_due" as const }
        }

        // A due wake joins ordinary admission behind every existing Worker
        // Slot waiter before it attempts to take any capacity itself.
        yield* admitWaitingWorkItems

        const now = yield* Clock.currentTimeMillis
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const latestRows = yield* sql
                .unsafe(
                  `SELECT step, status, postponed_until
                 FROM step_run
                 WHERE work_item_id = ?
                 ORDER BY queued_at DESC, rowid DESC
                 LIMIT 1`,
                  [workItemId],
                )
                .pipe(Effect.flatMap(decodeLatestStepRunStatusRows))
              const latest = latestRows[0]
              if (
                latest?.status !== "postponed" ||
                latest.postponed_until !== postponedUntil
              ) {
                return { _tag: "stale" as const }
              }
              if (postponedUntil > now) {
                return { _tag: "not_due" as const }
              }

              const workItem = yield* loadWorkItemRow(workItemId)
              if (
                workItem?.state !== latest.step ||
                workItem.paused ||
                workItem.waiting_for_blockers
              ) {
                return { _tag: "stale" as const }
              }

              const acquired = yield* tryAcquireWorkerSlot(workItemId, now)
              if (!acquired) {
                return { _tag: "woke" as const }
              }
              yield* enqueueStepRunForWorkItem(workItemId, latest.step, now)
              return { _tag: "woke" as const }
            }),
          )
          .pipe(
            Effect.catch(catchTransactionError),
            Effect.map((value): WakePostponedStepResult => {
              if (
                typeof value === "object" &&
                value !== null &&
                "_tag" in value &&
                value._tag === "woke"
              ) {
                return { _tag: "woke" }
              }
              if (
                typeof value === "object" &&
                value !== null &&
                "_tag" in value &&
                value._tag === "not_due"
              ) {
                return { _tag: "not_due" }
              }
              return { _tag: "stale" }
            }),
          )

        const workItem = yield* loadWorkItemRow(workItemId)
        if (workItem) {
          yield* notifyWorkItemsChanged(workItem.repository_id)
        }
        return result
      })

      const runStep = Effect.fn("WorkItemLifecycle.runStep")(function* (
        stepRunId: string,
      ) {
        const stepRun = yield* loadStepRunRow(stepRunId)
        if (!stepRun) {
          return yield* new StepRunNotFoundError({ stepRunId })
        }

        const workItem = yield* loadWorkItemRow(stepRun.work_item_id)
        if (!workItem) {
          return yield* new WorkItemNotFoundError({
            workItemId: stepRun.work_item_id,
          })
        }

        const cancel = yield* Deferred.make<void>()
        const finished = yield* Deferred.make<void>()
        const controller = {
          workItemId: workItem.id,
          cancel,
          finished,
        }

        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            if (
              resettingWorkItems.has(workItem.id) ||
              mergeSupersedingWorkItems.has(workItem.id) ||
              activeStepExecutions.has(stepRunId)
            ) {
              return false
            }
            activeStepExecutions.set(stepRunId, controller)
            return true
          }),
          (registered): Effect.Effect<RunStepResult, RunStepError> => {
            if (!registered) {
              return Effect.succeed({ _tag: "noop" as const })
            }

            return Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis
              const startedRows = (yield* sql
                .unsafe(
                  `UPDATE step_run
            SET status = 'running', started_at = ?, updated_at = ?
            WHERE id = ?
              AND status = 'queued'
              AND step = ?
              AND EXISTS (
                SELECT 1 FROM work_item
                WHERE work_item.id = step_run.work_item_id
                  AND work_item.state = step_run.step
                  AND work_item.paused = 0
                  AND work_item.state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')
              )
              AND NOT EXISTS (
                SELECT 1 FROM step_run AS other
                 WHERE other.work_item_id = step_run.work_item_id
                   AND other.status = 'running'
                   AND other.id != step_run.id
               )
              RETURNING ${STEP_RUN_SELECT_COLUMNS}`,
                  [startedAt, startedAt, stepRunId, stepRun.step],
                )
                .pipe(
                  Effect.mapError(toDatabaseError),
                )) as readonly StepRunRow[]

              const afterStart = startedRows[0]
              if (!afterStart) {
                const current = yield* loadStepRunRow(stepRunId)
                if (current?.status === "running") {
                  const recovered =
                    current.session_wait_started_at === null
                      ? current
                      : ((
                          (yield* sql
                            .unsafe(
                              `UPDATE step_run
                             SET session_wait_started_at = NULL,
                                 reason_code = NULL,
                                 reason_message = NULL,
                                 updated_at = ?
                             WHERE id = ?
                               AND status = 'running'
                             RETURNING ${STEP_RUN_SELECT_COLUMNS}`,
                              [startedAt, current.id],
                            )
                            .pipe(
                              Effect.mapError(toDatabaseError),
                            )) as readonly StepRunRow[]
                        )[0] ?? current)
                  // A duplicate delivery in this process exits before this point
                  // because activeStepExecutions already contains the Step Run.
                  // An open wait here therefore belongs to a stopped process.
                  const maxDurationMs = Duration.toMillis(
                    maxDurations[recovered.step],
                  )
                  const nowMs = yield* Clock.currentTimeMillis
                  const productiveElapsedMs = computeProductiveElapsedMs(
                    recovered,
                    nowMs,
                  )
                  const leaseExpired = productiveElapsedMs >= maxDurationMs
                  if (leaseExpired) {
                    yield* completeInterruptedStep({
                      stepRun: recovered,
                      reasonMessage:
                        "Visibility lease expired while the Step Run was still Running",
                    })
                  }
                  return { _tag: "noop" as const }
                }
                if (
                  current &&
                  (current.status === "succeeded" ||
                    current.status === "failed" ||
                    current.status === "interrupted" ||
                    current.status === "cancelled")
                ) {
                  yield* acknowledgeStaleDelivery(current)
                }
                return { _tag: "noop" as const }
              }

              yield* notifyWorkItemsChanged(workItem.repository_id)

              if (isAgentDependentLifecycleStep(stepRun.step)) {
                // Fail closed on corrupt capture: getBackendStatus normalizes
                // unknown ids to the default backend, which would silently
                // evaluate the wrong backend's readiness.
                if (!isSelectableAgentBackendId(workItem.agent_backend)) {
                  const reasonMessage = `Work Item captured Agent Backend is not selectable: ${workItem.agent_backend}`
                  const failed = yield* completeFailedStep({
                    stepRun: afterStart,
                    workItem,
                    reasonCode: STEP_RUN_REASON.agentBackendUnavailable,
                    reasonMessage,
                    cause: Cause.fail(reasonMessage),
                  })
                  return { _tag: "processed" as const, workItem: failed }
                }
                const readiness = yield* activeAgentBackend.getBackendStatus(
                  workItem.agent_backend as AgentBackendId,
                )
                if (readiness === null || readiness.kind === "unavailable") {
                  const reasonMessage =
                    readiness?.reason ??
                    (readiness === null
                      ? "Agent Backend is not Active"
                      : "Agent Backend is unavailable")
                  const failed = yield* completeFailedStep({
                    stepRun: afterStart,
                    workItem,
                    reasonCode: STEP_RUN_REASON.agentBackendUnavailable,
                    reasonMessage,
                    cause: Cause.fail(reasonMessage),
                  })
                  return { _tag: "processed" as const, workItem: failed }
                }
              }

              const maxDuration = maxDurations[stepRun.step]
              const modelOutcome = yield* resolveModelsForBackend(
                workItem.repository_id,
                workItem.agent_backend,
              ).pipe(
                Effect.map(
                  (
                    selection,
                  ):
                    | {
                        readonly _tag: "ok"
                        readonly selection: AgentModelSelection
                      }
                    | {
                        readonly _tag: "failed"
                        readonly workItem: WorkItemRecord
                      } => ({ _tag: "ok", selection }),
                ),
                Effect.catchTag(
                  "BuildModelNotConfiguredError",
                  (
                    error,
                  ): Effect.Effect<
                    | {
                        readonly _tag: "ok"
                        readonly selection: AgentModelSelection
                      }
                    | {
                        readonly _tag: "failed"
                        readonly workItem: WorkItemRecord
                      },
                    RunStepError
                  > => {
                    if (!isAgentDependentLifecycleStep(stepRun.step)) {
                      return Effect.succeed({
                        _tag: "ok",
                        selection: EMPTY_AGENT_MODEL_SELECTION,
                      })
                    }
                    return completeFailedStep({
                      stepRun: afterStart,
                      workItem,
                      reasonCode: STEP_RUN_REASON.buildModelNotConfigured,
                      reasonMessage: error.message,
                      cause: Cause.fail(error.message),
                    }).pipe(
                      Effect.map((failed) => ({
                        _tag: "failed" as const,
                        workItem: failed,
                      })),
                    )
                  },
                ),
              )
              if (modelOutcome._tag === "failed") {
                return {
                  _tag: "processed" as const,
                  workItem: modelOutcome.workItem,
                }
              }
              const selection = modelOutcome.selection

              // Pre-Agent-Turn catalog admission (issue #838): a Work Item
              // configured with a model the backend no longer offers fails
              // here with actionable guidance instead of spawning the CLI and
              // burning an Agent Turn on a certain failure.
              if (isAgentDependentLifecycleStep(stepRun.step)) {
                const catalogStatus =
                  yield* activeAgentBackend.getBackendStatus(
                    workItem.agent_backend as AgentBackendId,
                  )
                const violation =
                  catalogStatus === null || catalogStatus.kind !== "ready"
                    ? null
                    : agentModelCatalogViolation({
                        backendLabel: catalogStatus.backend.label,
                        catalogModelIds: catalogStatus.models.map(
                          (model) => model.id,
                        ),
                        selection,
                        includeReviewModel: stepRun.step === "review",
                      })
                if (violation !== null) {
                  const failed = yield* completeFailedStep({
                    stepRun: afterStart,
                    workItem,
                    reasonCode: STEP_RUN_REASON.agentModelNotInCatalog,
                    reasonMessage: violation,
                    cause: Cause.fail(violation),
                  })
                  return { _tag: "processed" as const, workItem: failed }
                }
              }

              const context: LifecycleStepContext = {
                workItemId: workItem.id as WorkItemId,
                repositoryId: workItem.repository_id,
                issueNumber: workItem.issue_number,
                issueTitle: workItem.issue_title,
                agentBackend: workItem.agent_backend,
                model: selection.model,
                thinkingLevel: selection.thinkingLevel,
                reviewModel: selection.reviewModel,
                reviewThinkingLevel: selection.reviewThinkingLevel,
                worktreePath: workItem.worktree_path,
                startingCommitOid: workItem.starting_commit_oid,
                completionSummary: workItem.completion_summary,
                publicationTitle: workItem.publication_title,
                publicationBody: workItem.publication_body,
                sessionId: workItem.session_id,
                maxDuration,
              }

              const productiveTimeout: Effect.Effect<
                never,
                Cause.TimeoutError | WorkItemLifecycleDatabaseError
              > = Effect.gen(function* () {
                const maxDurationMs = Duration.toMillis(maxDuration)
                for (;;) {
                  const nowMs = yield* Clock.currentTimeMillis
                  const current = yield* loadStepRunRow(afterStart.id)
                  if (current === null || current.status !== "running") {
                    return yield* Effect.never
                  }
                  const productiveElapsedMs = computeProductiveElapsedMs(
                    current,
                    nowMs,
                  )
                  if (productiveElapsedMs >= maxDurationMs) {
                    return yield* new Cause.TimeoutError()
                  }
                  const remainingMs = maxDurationMs - productiveElapsedMs
                  const waitingForSession =
                    current.session_wait_started_at !== null ||
                    current.reason_code === STEP_RUN_REASON.waitingForAgentTurn
                  // While session-slot wait freezes the clock, poll; otherwise
                  // sleep up to the remaining productive budget (capped).
                  const sleepMs = waitingForSession
                    ? Math.min(500, Math.max(remainingMs, 50))
                    : Math.min(remainingMs, 50)
                  yield* Effect.sleep(Duration.millis(Math.max(1, sleepMs)))
                }
              })

              const result = yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const handlerExit = yield* Effect.exit(
                    restore(
                      Effect.raceFirst(
                        Effect.suspend(() =>
                          runHandler(stepRun.step, context, workItem),
                        ).pipe(
                          Effect.provideService(CurrentStepRun, {
                            stepRunId: afterStart.id,
                            repositoryId: workItem.repository_id,
                          }),
                          Effect.provideService(
                            CurrentCapturedAgentBackendId,
                            workItem.agent_backend,
                          ),
                          Effect.raceFirst(productiveTimeout),
                        ),
                        Deferred.await(cancel).pipe(
                          Effect.andThen(Effect.interrupt),
                        ),
                      ),
                    ),
                  )

                  if (Exit.isFailure(handlerExit)) {
                    const handlerError = Cause.findErrorOption(
                      handlerExit.cause,
                    )
                    if (
                      Option.isSome(handlerError) &&
                      isGitHubThrottledError(handlerError.value)
                    ) {
                      const postponed = yield* completePostponedStep({
                        stepRun: afterStart,
                        workItem,
                        retryAt: handlerError.value.retryAt,
                      })
                      return {
                        _tag: "processed" as const,
                        workItem: postponed,
                      }
                    }
                    const classification = classifyHandlerFailure(
                      handlerExit.cause,
                    )
                    const isTimeout =
                      classification.reasonCode === STEP_RUN_REASON.timeout
                    if (
                      !isTimeout &&
                      Cause.hasInterruptsOnly(handlerExit.cause)
                    ) {
                      yield* completeInterruptedStep({
                        stepRun: afterStart,
                        reasonMessage:
                          "Lifecycle Step was interrupted before an outcome could be established",
                        cause: handlerExit.cause,
                      })
                      const interrupted = yield* getWorkItem(workItem.id).pipe(
                        Effect.catchTag(
                          "WorkItemNotFoundError",
                          (error) =>
                            new WorkItemLifecycleDatabaseError({
                              message: `Work Item missing after interruption: ${error.workItemId}`,
                              cause: error,
                            }),
                        ),
                      )
                      return {
                        _tag: "processed" as const,
                        workItem: interrupted,
                      }
                    }

                    const eligibility = closeIssueEligibilityFailure(
                      handlerExit.cause,
                    )
                    const failed = yield* completeFailedStep({
                      stepRun: afterStart,
                      workItem,
                      reasonCode: classification.reasonCode,
                      reasonMessage: classification.reasonMessage,
                      cause: handlerExit.cause,
                      terminalFailure:
                        eligibility === null
                          ? undefined
                          : {
                              failureCode: eligibility.failureCode,
                              failureMessage: eligibility.failureMessage,
                            },
                    })
                    return { _tag: "processed" as const, workItem: failed }
                  }

                  const revalidation =
                    stepRun.step === "local_cleanup" ||
                    stepRun.step === "close_issue"
                      ? ({ ok: true } as const)
                      : yield* revalidateIssue(
                          workItem.repository_id,
                          workItem.issue_number,
                        )

                  const completed = yield* completeSuccessfulStep({
                    stepRun: afterStart,
                    workItem,
                    output: handlerExit.value,
                    revalidation,
                  }).pipe(
                    Effect.catch((error) =>
                      isGitHubThrottledError(error)
                        ? completePostponedStep({
                            stepRun: afterStart,
                            workItem,
                            retryAt: error.retryAt,
                          })
                        : Effect.fail(error),
                    ),
                  )

                  return { _tag: "processed" as const, workItem: completed }
                }),
              )

              return result
            })
          },
          () =>
            Effect.gen(function* () {
              if (activeStepExecutions.get(stepRunId) === controller) {
                activeStepExecutions.delete(stepRunId)
              }
              yield* Deferred.succeed(finished, undefined)
            }),
        )
      })

      const pause = Effect.fn("WorkItemLifecycle.pause")(function* (
        workItemId: string,
      ) {
        const workItem = yield* loadWorkItemRow(workItemId)
        if (!workItem) {
          return yield* new WorkItemNotFoundError({ workItemId })
        }

        if (isTerminalWorkItemState(workItem.state)) {
          return yield* new WorkItemTerminalError({
            workItemId,
            state: workItem.state,
          })
        }

        if (workItem.waiting_for_blockers) {
          return yield* new WorkItemWaitingForBlockersError({
            workItemId,
            operation: "pause",
          })
        }

        if (workItem.paused) {
          return yield* getWorkItem(workItemId)
        }

        const now = yield* Clock.currentTimeMillis

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const pausedRows = (yield* sql.unsafe(
                `UPDATE work_item
                  SET paused = 1,
                      updated_at = ?
                  WHERE id = ?
                    AND state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')
                  RETURNING id`,
                [now, workItemId],
              )) as readonly { readonly id: string }[]

              if (!pausedRows[0]) {
                const current = yield* loadWorkItemRow(workItemId)
                if (!current) {
                  return yield* new WorkItemNotFoundError({ workItemId })
                }
                if (isTerminalWorkItemState(current.state)) {
                  return yield* new WorkItemTerminalError({
                    workItemId,
                    state: current.state,
                  })
                }
              }

              const cancelledRows = (yield* sql.unsafe(
                `UPDATE step_run
                 SET status = 'cancelled',
                     finished_at = ?,
                     reason_code = ?,
                     reason_message = ?,
                     updated_at = ?
                 WHERE work_item_id = ? AND status = 'queued'
                 RETURNING queue_job_id`,
                [
                  now,
                  STEP_RUN_REASON.paused,
                  "Work Item was paused before the Step Run started",
                  now,
                  workItemId,
                ],
              )) as readonly { readonly queue_job_id: string | null }[]

              for (const cancelled of cancelledRows) {
                if (cancelled.queue_job_id !== null) {
                  yield* queue
                    .acknowledge(cancelled.queue_job_id)
                    .pipe(
                      Effect.catchTag("JobNotFoundError", () => Effect.void),
                    )
                }
              }

              // Release immediately when no Step Run is running; hold while running.
              const runningRows = (yield* sql.unsafe(
                `SELECT id FROM step_run
                 WHERE work_item_id = ? AND status = 'running'
                 LIMIT 1`,
                [workItemId],
              )) as readonly { readonly id: string }[]
              if (!runningRows[0]) {
                yield* sql.unsafe(
                  `UPDATE work_item
                   SET holds_worker_slot = 0,
                       waiting_since = NULL,
                       updated_at = ?
                   WHERE id = ?`,
                  [now, workItemId],
                )
              }
            }),
          )
          .pipe(
            Effect.catch((error): Effect.Effect<never, PauseError> => {
              if (
                error instanceof WorkItemNotFoundError ||
                error instanceof WorkItemTerminalError
              ) {
                return Effect.fail(error)
              }
              if (error instanceof WorkItemLifecycleDatabaseError) {
                return Effect.fail(error)
              }
              if (
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                (error as { _tag: string })._tag === "SqlError"
              ) {
                return Effect.fail(toDatabaseError(error as SqlError))
              }
              if (
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                ((error as { _tag: string })._tag === "AcknowledgeError" ||
                  (error as { _tag: string })._tag === "JobNotFoundError")
              ) {
                return Effect.fail(
                  error as unknown as AcknowledgeError | JobNotFoundError,
                )
              }
              return Effect.fail(
                new WorkItemLifecycleDatabaseError({
                  message: `Unexpected transaction failure: ${String(error)}`,
                  cause: error,
                }),
              )
            }),
          )

        const paused = yield* getWorkItem(workItemId).pipe(
          Effect.catchTag(
            "WorkItemNotFoundError",
            (error) =>
              new WorkItemLifecycleDatabaseError({
                message: `Work Item missing after pause: ${error.workItemId}`,
                cause: error,
              }),
          ),
        )
        yield* notifyWorkItemsChanged(paused.repositoryId)
        if (!paused.holdsWorkerSlot) {
          yield* admitWaitingWorkItems.pipe(
            Effect.catch((error) =>
              Effect.logError("Failed to admit waiters after pause", {
                error: String(error),
              }),
            ),
          )
        }
        return paused
      })

      const start = Effect.fn("WorkItemLifecycle.start")(function* (
        workItemId: string,
      ) {
        const workItem = yield* loadWorkItemRow(workItemId)
        if (!workItem) {
          return yield* new WorkItemNotFoundError({ workItemId })
        }

        if (isTerminalWorkItemState(workItem.state)) {
          return yield* new WorkItemTerminalError({
            workItemId,
            state: workItem.state,
          })
        }

        if (workItem.waiting_for_blockers) {
          return yield* new WorkItemWaitingForBlockersError({
            workItemId,
            operation: "start",
          })
        }

        const now = yield* Clock.currentTimeMillis
        if (!workItem.paused) {
          const latestRows = yield* sql
            .unsafe(
              `SELECT step, status, postponed_until FROM step_run
               WHERE work_item_id = ?
               ORDER BY queued_at DESC, rowid DESC
               LIMIT 1`,
              [workItemId],
            )
            .pipe(
              Effect.mapError(toDatabaseError),
              Effect.flatMap(decodeLatestStepRunStatusRows),
            )
          const latest = latestRows[0]
          if (
            latest?.status !== "postponed" ||
            latest.step !== workItem.state ||
            latest.postponed_until === null ||
            latest.postponed_until > now
          ) {
            return yield* getWorkItem(workItemId)
          }
        }

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const startedRows = yield* sql
                .unsafe(
                  `UPDATE work_item
                  SET paused = 0,
                      failure_code = NULL,
                      failure_message = NULL,
                      updated_at = ?
                  WHERE id = ?
                    AND state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')
                    AND (
                      paused = 1
                      OR (
                        (
                          SELECT step FROM step_run
                          WHERE work_item_id = ?
                          ORDER BY queued_at DESC, rowid DESC
                          LIMIT 1
                        ) = state
                        AND (
                          SELECT status FROM step_run
                          WHERE work_item_id = ?
                          ORDER BY queued_at DESC, rowid DESC
                          LIMIT 1
                        ) = 'postponed'
                        AND (
                          SELECT postponed_until FROM step_run
                          WHERE work_item_id = ?
                          ORDER BY queued_at DESC, rowid DESC
                          LIMIT 1
                        ) <= ?
                      )
                    )
                  RETURNING id, state`,
                  [now, workItemId, workItemId, workItemId, workItemId, now],
                )
                .pipe(Effect.flatMap(decodeStartedWorkItemRows))

              if (!startedRows[0]) {
                const current = yield* loadWorkItemRow(workItemId)
                if (!current) {
                  return yield* new WorkItemNotFoundError({ workItemId })
                }
                if (isTerminalWorkItemState(current.state)) {
                  return yield* new WorkItemTerminalError({
                    workItemId,
                    state: current.state,
                  })
                }
                return
              }

              const pendingStep = startedRows[0].state

              const activeRows = yield* sql
                .unsafe(
                  `SELECT id FROM step_run
                 WHERE work_item_id = ?
                   AND status IN ('queued', 'running')
                 LIMIT 1`,
                  [workItemId],
                )
                .pipe(Effect.flatMap(decodeActiveStepRunRows))
              if (activeRows[0]) {
                // Running Step Run still holds the slot from Pause-while-running.
                return
              }

              const latestRows = yield* sql
                .unsafe(
                  `SELECT status, postponed_until FROM step_run
                 WHERE work_item_id = ?
                   AND step = ?
                 ORDER BY queued_at DESC, rowid DESC
                 LIMIT 1`,
                  [workItemId, pendingStep],
                )
                .pipe(Effect.flatMap(decodeLatestStepRunDeadlineRows))
              const latestStatus = latestRows[0]?.status
              if (latestStatus === "failed" || latestStatus === "interrupted") {
                return
              }
              const postponedUntil = latestRows[0]?.postponed_until
              if (
                latestStatus === "postponed" &&
                typeof postponedUntil === "number" &&
                postponedUntil > now
              ) {
                // Start may clear an explicit Pause, but never lets an
                // operator bypass GitHub's authoritative retry deadline.
                return
              }

              const acquired = yield* tryAcquireWorkerSlot(workItemId, now)
              if (!acquired) {
                return
              }

              yield* enqueueStepRunForWorkItem(workItemId, pendingStep, now)
            }),
          )
          .pipe(
            Effect.catch((error): Effect.Effect<never, StartError> => {
              if (
                error instanceof WorkItemNotFoundError ||
                error instanceof WorkItemTerminalError
              ) {
                return Effect.fail(error)
              }
              if (error instanceof WorkItemLifecycleDatabaseError) {
                return Effect.fail(error)
              }
              if (error instanceof EnqueueError) {
                return Effect.fail(error)
              }
              if (error instanceof InvalidQueueNameError) {
                return Effect.fail(error)
              }
              if (
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                (error as { _tag: string })._tag === "SqlError"
              ) {
                return Effect.fail(toDatabaseError(error as SqlError))
              }
              if (
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                ((error as { _tag: string })._tag === "AcknowledgeError" ||
                  (error as { _tag: string })._tag === "JobNotFoundError")
              ) {
                return Effect.fail(
                  error as unknown as AcknowledgeError | JobNotFoundError,
                )
              }
              return Effect.fail(
                new WorkItemLifecycleDatabaseError({
                  message: `Unexpected transaction failure: ${String(error)}`,
                  cause: error,
                }),
              )
            }),
          )

        const started = yield* getWorkItem(workItemId).pipe(
          Effect.catchTag(
            "WorkItemNotFoundError",
            (error) =>
              new WorkItemLifecycleDatabaseError({
                message: `Work Item missing after start: ${error.workItemId}`,
                cause: error,
              }),
          ),
        )
        yield* notifyWorkItemsChanged(started.repositoryId)
        return started
      })

      const toLifecycleStepContext = (
        row: WorkItemRow,
        models: AgentModelSelection = EMPTY_AGENT_MODEL_SELECTION,
      ): LifecycleStepContext => ({
        workItemId: row.id as WorkItemId,
        repositoryId: row.repository_id,
        issueNumber: row.issue_number,
        issueTitle: row.issue_title,
        agentBackend: row.agent_backend,
        model: models.model,
        thinkingLevel: models.thinkingLevel,
        reviewModel: models.reviewModel,
        reviewThinkingLevel: models.reviewThinkingLevel,
        worktreePath: row.worktree_path,
        startingCommitOid: row.starting_commit_oid,
        completionSummary: row.completion_summary,
        publicationTitle: row.publication_title,
        publicationBody: row.publication_body,
        sessionId: row.session_id,
      })

      const isMergeNeedsHumanHandoff = (
        row: WorkItemRow,
        latestStep: OperationalLifecycleStep | null,
      ): boolean =>
        row.state === "needs_human" &&
        row.pull_request_number !== null &&
        (latestStep === "decide_pr_merge" || latestStep === "merge_pr")

      const isResolveNeedsHumanHandoff = (
        row: WorkItemRow,
        latestStep: OperationalLifecycleStep | null,
      ): boolean =>
        row.state === "needs_human" &&
        row.pull_request_number !== null &&
        latestStep === "resolve_pr_merge_conflict"

      /** Closed-unmerged Abandon eligibility (ADR 0039 / 0046). */
      const isClosedUnmergedAbandonHandoff = (
        row: WorkItemRow,
        latestStep: OperationalLifecycleStep | null,
      ): boolean =>
        isMergeNeedsHumanHandoff(row, latestStep) ||
        isResolveNeedsHumanHandoff(row, latestStep)

      const loadLatestStep = (
        workItemId: string,
      ): Effect.Effect<
        OperationalLifecycleStep | null,
        WorkItemLifecycleDatabaseError
      > =>
        Effect.gen(function* () {
          const rows = (yield* sql
            .unsafe(
              `SELECT step FROM step_run
               WHERE work_item_id = ?
               ORDER BY queued_at DESC, rowid DESC
               LIMIT 1`,
              [workItemId],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            readonly step: OperationalLifecycleStep
          }[]
          return rows[0]?.step ?? null
        })

      const cleanupNeedsHumanWorktree = (
        row: WorkItemRow,
      ): Effect.Effect<void, AbandonCleanupError> =>
        steps.localCleanup(toLifecycleStepContext(row)).pipe(
          Effect.mapError(
            (cause) =>
              new AbandonCleanupError({
                workItemId: row.id,
                message: `Failed to clean up worktree for Needs Human Work Item ${row.id}`,
                cause,
              }),
          ),
        )

      const abandon = Effect.fn("WorkItemLifecycle.abandon")(function* (
        workItemId: string,
      ) {
        const workItem = yield* loadWorkItemRow(workItemId)
        if (!workItem) {
          return yield* new WorkItemNotFoundError({ workItemId })
        }

        if (workItem.state === "needs_human") {
          const nowAcquire = yield* Clock.currentTimeMillis
          const acquired = yield* sql
            .withTransaction(tryAcquireWorkerSlot(workItemId, nowAcquire))
            .pipe(
              Effect.mapError((error): WorkItemLifecycleDatabaseError => {
                if (error instanceof WorkItemLifecycleDatabaseError) {
                  return error
                }
                if (
                  typeof error === "object" &&
                  error !== null &&
                  "_tag" in error &&
                  (error as { _tag: string })._tag === "SqlError"
                ) {
                  return toDatabaseError(error as SqlError)
                }
                return new WorkItemLifecycleDatabaseError({
                  message: `Failed to acquire Worker Slot for abandon: ${String(error)}`,
                  cause: error,
                })
              }),
            )
          if (!acquired) {
            const waiting = yield* getWorkItem(workItemId).pipe(
              Effect.catchTag(
                "WorkItemNotFoundError",
                (error) =>
                  new WorkItemLifecycleDatabaseError({
                    message: `Work Item missing after waiting for abandon: ${error.workItemId}`,
                    cause: error,
                  }),
              ),
            )
            yield* notifyWorkItemsChanged(waiting.repositoryId)
            return waiting
          }
          const current = yield* loadWorkItemRow(workItemId)
          if (!current) {
            return yield* new WorkItemNotFoundError({ workItemId })
          }
          yield* cleanupNeedsHumanWorktree(current)
        } else if (isTerminalWorkItemState(workItem.state)) {
          return yield* new WorkItemTerminalError({
            workItemId,
            state: workItem.state,
          })
        }

        const now = yield* Clock.currentTimeMillis
        const clearFailure = workItem.state === "needs_human"

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const abandonedRows = (yield* sql.unsafe(
                clearFailure
                  ? `UPDATE work_item
                  SET state = 'abandoned',
                      state_ready_at = ?,
                      failure_code = NULL,
                      failure_message = NULL,
                      worktree_path = NULL,
                      holds_worker_slot = 0,
                      waiting_since = NULL,
                      waiting_for_blockers = 0,
                      updated_at = ?
                  WHERE id = ?
                    AND state = 'needs_human'
                    AND NOT EXISTS (
                      SELECT 1 FROM step_run
                      WHERE step_run.work_item_id = work_item.id
                        AND step_run.status = 'running'
                    )
                  RETURNING id`
                  : `UPDATE work_item
                  SET state = 'abandoned',
                      state_ready_at = ?,
                      holds_worker_slot = 0,
                      waiting_since = NULL,
                      waiting_for_blockers = 0,
                      updated_at = ?
                  WHERE id = ?
                    AND state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')
                    AND NOT EXISTS (
                      SELECT 1 FROM step_run
                      WHERE step_run.work_item_id = work_item.id
                        AND step_run.status = 'running'
                    )
                  RETURNING id`,
                [now, now, workItemId],
              )) as readonly { readonly id: string }[]

              if (!abandonedRows[0]) {
                const current = yield* loadWorkItemRow(workItemId)
                if (!current) {
                  return yield* new WorkItemNotFoundError({ workItemId })
                }
                if (
                  isTerminalWorkItemState(current.state) &&
                  current.state !== "needs_human"
                ) {
                  return yield* new WorkItemTerminalError({
                    workItemId,
                    state: current.state,
                  })
                }
                if (current.state === "needs_human" && !clearFailure) {
                  return yield* new WorkItemTerminalError({
                    workItemId,
                    state: current.state,
                  })
                }

                const runningRows = (yield* sql.unsafe(
                  `SELECT id FROM step_run
                   WHERE work_item_id = ? AND status = 'running'
                   ORDER BY queued_at DESC, rowid DESC
                   LIMIT 1`,
                  [workItemId],
                )) as readonly { readonly id: string }[]
                return yield* new WorkItemHasRunningStepError({
                  workItemId,
                  stepRunId: runningRows[0]?.id ?? "unknown",
                })
              }

              const cancelledRows = (yield* sql.unsafe(
                `UPDATE step_run
                 SET status = 'cancelled',
                     finished_at = ?,
                     reason_code = ?,
                     reason_message = ?,
                     updated_at = ?
                 WHERE work_item_id = ? AND status = 'queued'
                 RETURNING queue_job_id`,
                [
                  now,
                  STEP_RUN_REASON.abandoned,
                  "Work Item was abandoned before the Step Run started",
                  now,
                  workItemId,
                ],
              )) as readonly { readonly queue_job_id: string | null }[]

              for (const cancelled of cancelledRows) {
                if (cancelled.queue_job_id !== null) {
                  yield* queue
                    .acknowledge(cancelled.queue_job_id)
                    .pipe(
                      Effect.catchTag("JobNotFoundError", () => Effect.void),
                    )
                }
              }
            }).pipe((mutation) =>
              applyLifecycleTransition(
                workItemId,
                "abandoned",
                mutation,
                () => true,
              ),
            ),
          )
          .pipe(
            Effect.catch((error): Effect.Effect<never, AbandonError> => {
              if (
                error instanceof WorkItemNotFoundError ||
                error instanceof WorkItemTerminalError ||
                error instanceof WorkItemHasRunningStepError ||
                error instanceof AbandonCleanupError
              ) {
                return Effect.fail(error)
              }
              if (error instanceof WorkItemLifecycleDatabaseError) {
                return Effect.fail(error)
              }
              if (
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                ((error as { _tag: string })._tag === "AcknowledgeError" ||
                  (error as { _tag: string })._tag === "JobNotFoundError")
              ) {
                return Effect.fail(error as AcknowledgeError | JobNotFoundError)
              }
              if (
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                (error as { _tag: string })._tag === "SqlError"
              ) {
                return Effect.fail(toDatabaseError(error as SqlError))
              }
              return Effect.fail(
                new WorkItemLifecycleDatabaseError({
                  message: `Unexpected transaction failure: ${String(error)}`,
                  cause: error,
                }),
              )
            }),
          )

        const abandoned = yield* getWorkItem(workItemId).pipe(
          Effect.catchTag(
            "WorkItemNotFoundError",
            (error) =>
              new WorkItemLifecycleDatabaseError({
                message: `Work Item missing after abandon: ${error.workItemId}`,
                cause: error,
              }),
          ),
        )
        yield* notifyWorkItemsChanged(abandoned.repositoryId)
        yield* admitWaitingWorkItems.pipe(
          Effect.catch((error) =>
            Effect.logError("Failed to admit waiters after abandon", {
              error: String(error),
            }),
          ),
        )
        return abandoned
      })

      const mapContinueAfterHumanPrOutcomeTransactionError = (
        error: unknown,
      ): Effect.Effect<never, ContinueAfterHumanPrOutcomeError> => {
        if (
          error instanceof NeedsHumanHandoffNotEligibleError ||
          error instanceof WorkItemNotFoundError ||
          error instanceof WorkItemLifecycleDatabaseError ||
          error instanceof EnqueueError ||
          error instanceof InvalidQueueNameError
        ) {
          return Effect.fail(error)
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          ((error as { _tag: string })._tag === "AcknowledgeError" ||
            (error as { _tag: string })._tag === "JobNotFoundError")
        ) {
          return Effect.fail(
            new WorkItemLifecycleDatabaseError({
              message: `Failed to acknowledge superseded Step Run jobs after merge: ${String(error)}`,
              cause: error,
            }),
          )
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          (error as { _tag: string })._tag === "SqlError"
        ) {
          return Effect.fail(toDatabaseError(error as SqlError))
        }
        return Effect.fail(
          new WorkItemLifecycleDatabaseError({
            message: `Unexpected failure resuming after human merge: ${String(error)}`,
            cause: error,
          }),
        )
      }

      const continueAfterHumanPrOutcome = Effect.fn(
        "WorkItemLifecycle.continueAfterHumanPrOutcome",
      )(function* (workItemId: string, outcome: HumanPrOutcome) {
        const workItem = yield* loadWorkItemRow(workItemId)
        if (!workItem) {
          return yield* new WorkItemNotFoundError({ workItemId })
        }

        if (outcome === "closed_unmerged") {
          const latestStep = yield* loadLatestStep(workItemId)
          if (!isClosedUnmergedAbandonHandoff(workItem, latestStep)) {
            return yield* new NeedsHumanHandoffNotEligibleError({
              workItemId,
              reason:
                "Work Item is not a Decide/Merge/Resolve Needs Human handoff with a Work Item PR",
            })
          }
          return yield* abandon(workItemId).pipe(
            Effect.mapError((error): ContinueAfterHumanPrOutcomeError => {
              if (
                error instanceof WorkItemNotFoundError ||
                error instanceof AbandonCleanupError ||
                error instanceof WorkItemLifecycleDatabaseError
              ) {
                return error
              }
              return new WorkItemLifecycleDatabaseError({
                message: `Failed to abandon Needs Human Work Item after closed PR: ${String(error)}`,
                cause: error,
              })
            }),
          )
        }

        if (
          outcome === "merge_conflict" ||
          outcome === "merge_conflict_cleared"
        ) {
          const latestStep = yield* loadLatestStep(workItemId)
          const eligible =
            outcome === "merge_conflict"
              ? isMergeNeedsHumanHandoff(workItem, latestStep)
              : isResolveNeedsHumanHandoff(workItem, latestStep)
          if (!eligible) {
            return yield* new NeedsHumanHandoffNotEligibleError({
              workItemId,
              reason:
                outcome === "merge_conflict"
                  ? "Work Item is not a Decide/Merge Needs Human handoff with a Work Item PR"
                  : "Work Item is not a Resolve PR Merge Conflict Needs Human handoff with a Work Item PR",
            })
          }

          const nextState =
            outcome === "merge_conflict"
              ? ("resolve_pr_merge_conflict" as const)
              : ("watch_pr_status_checks" as const)

          const now = yield* Clock.currentTimeMillis

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const current = yield* loadWorkItemRow(workItemId)
                if (!current) {
                  return yield* new WorkItemNotFoundError({ workItemId })
                }
                const currentLatest = yield* loadLatestStep(workItemId)
                const stillEligible =
                  outcome === "merge_conflict"
                    ? isMergeNeedsHumanHandoff(current, currentLatest)
                    : isResolveNeedsHumanHandoff(current, currentLatest)
                if (!stillEligible) {
                  return yield* new NeedsHumanHandoffNotEligibleError({
                    workItemId,
                    reason:
                      "Work Item is no longer eligible for mergeability advance",
                  })
                }

                const updated = (yield* sql.unsafe(
                  `UPDATE work_item
                   SET state = ?,
                       state_ready_at = ?,
                       failure_code = NULL,
                       failure_message = NULL,
                       updated_at = ?
                   WHERE id = ?
                     AND state = 'needs_human'
                   RETURNING id`,
                  [nextState, now, now, workItemId],
                )) as readonly { readonly id: string }[]

                if (!updated[0]) {
                  return yield* new NeedsHumanHandoffNotEligibleError({
                    workItemId,
                    reason:
                      "Work Item is no longer eligible for mergeability advance",
                  })
                }

                const acquired = yield* tryAcquireWorkerSlot(workItemId, now)
                if (!acquired) {
                  return true
                }

                const stillActive = (yield* sql.unsafe(
                  `SELECT id FROM step_run
                   WHERE work_item_id = ?
                     AND status IN ('queued', 'running')
                   LIMIT 1`,
                  [workItemId],
                )) as readonly { readonly id: string }[]
                if (stillActive[0]) {
                  return true
                }

                yield* enqueueStepRunForWorkItem(workItemId, nextState, now)
                return true
              }).pipe((mutation) =>
                applyLifecycleTransition(
                  workItemId,
                  nextState,
                  mutation,
                  (applied) => applied === true,
                ),
              ),
            )
            .pipe(Effect.catch(mapContinueAfterHumanPrOutcomeTransactionError))

          const advanced = yield* getWorkItem(workItemId).pipe(
            Effect.catchTag(
              "WorkItemNotFoundError",
              (error) =>
                new WorkItemLifecycleDatabaseError({
                  message: `Work Item missing after mergeability advance: ${error.workItemId}`,
                  cause: error,
                }),
            ),
          )
          yield* notifyWorkItemsChanged(advanced.repositoryId)
          return advanced
        }

        // Merged: supersede any unfinished Work Item that owns a Work Item PR.
        if (
          workItem.state === "complete" ||
          workItem.state === "failed" ||
          workItem.state === "abandoned"
        ) {
          return yield* new NeedsHumanHandoffNotEligibleError({
            workItemId,
            reason: "Work Item is already terminal",
          })
        }
        if (workItem.pull_request_number === null) {
          return yield* new NeedsHumanHandoffNotEligibleError({
            workItemId,
            reason: "Work Item has no Work Item PR",
          })
        }
        if (workItem.state === "local_cleanup") {
          return yield* getWorkItem(workItemId)
        }

        yield* Effect.sync(() => mergeSupersedingWorkItems.add(workItemId))

        return yield* Effect.gen(function* () {
          // Snapshot active Step Runs before interrupt so we can label them
          // pr_merged even when in-process interrupt finishes them first.
          const supersedingStepRuns = (yield* sql
            .unsafe(
              `SELECT id, status, queue_job_id FROM step_run
               WHERE work_item_id = ?
                 AND status IN ('queued', 'running')`,
              [workItemId],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            readonly id: string
            readonly status: string
            readonly queue_job_id: string | null
          }[]

          const activeExecutions = [...activeStepExecutions.values()].filter(
            (execution) => execution.workItemId === workItemId,
          )
          yield* Effect.forEach(
            activeExecutions,
            ({ cancel }) => Deferred.succeed(cancel, undefined),
            { discard: true },
          )
          yield* Effect.forEach(
            activeExecutions,
            ({ finished }) => Deferred.await(finished),
            { discard: true },
          )

          const now = yield* Clock.currentTimeMillis

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const current = yield* loadWorkItemRow(workItemId)
                if (!current) {
                  return yield* new WorkItemNotFoundError({ workItemId })
                }
                if (
                  current.state === "complete" ||
                  current.state === "failed" ||
                  current.state === "abandoned"
                ) {
                  return yield* new NeedsHumanHandoffNotEligibleError({
                    workItemId,
                    reason: "Work Item is already terminal",
                  })
                }
                if (current.pull_request_number === null) {
                  return yield* new NeedsHumanHandoffNotEligibleError({
                    workItemId,
                    reason: "Work Item has no Work Item PR",
                  })
                }
                if (current.state === "local_cleanup") {
                  return
                }

                yield* Effect.gen(function* () {
                  for (const active of supersedingStepRuns) {
                    // Label by id from the pre-interrupt snapshot. A snapshotted
                    // queued row may become interrupted if it started before
                    // cancel landed; never overwrite a terminal Effect outcome.
                    yield* sql.unsafe(
                      `UPDATE step_run
                     SET status = CASE
                           WHEN status IN ('queued', 'cancelled') THEN 'cancelled'
                           ELSE 'interrupted'
                         END,
                         finished_at = COALESCE(finished_at, ?),
                         reason_code = ?,
                         reason_message = CASE
                           WHEN status IN ('queued', 'cancelled')
                             THEN ?
                           ELSE ?
                         END,
                         updated_at = ?
                     WHERE id = ?
                       AND status IN (
                         'queued',
                         'running',
                         'interrupted',
                         'cancelled'
                       )`,
                      [
                        now,
                        STEP_RUN_REASON.prMerged,
                        "Work Item PR was merged before the Step Run started",
                        "Work Item PR was merged; Step Run superseded",
                        now,
                        active.id,
                      ],
                    )
                    if (active.queue_job_id !== null) {
                      yield* queue
                        .acknowledge(active.queue_job_id)
                        .pipe(
                          Effect.catchTag(
                            "JobNotFoundError",
                            () => Effect.void,
                          ),
                        )
                    }
                  }

                  // Catch any Step Run that became active after the snapshot.
                  yield* sql.unsafe(
                    `UPDATE step_run
                   SET status = 'interrupted',
                       finished_at = COALESCE(finished_at, ?),
                       reason_code = ?,
                       reason_message = ?,
                       updated_at = ?
                   WHERE work_item_id = ? AND status = 'running'`,
                    [
                      now,
                      STEP_RUN_REASON.prMerged,
                      "Work Item PR was merged; Step Run superseded",
                      now,
                      workItemId,
                    ],
                  )
                  const lateQueued = (yield* sql.unsafe(
                    `UPDATE step_run
                   SET status = 'cancelled',
                       finished_at = ?,
                       reason_code = ?,
                       reason_message = ?,
                       updated_at = ?
                   WHERE work_item_id = ? AND status = 'queued'
                   RETURNING queue_job_id`,
                    [
                      now,
                      STEP_RUN_REASON.prMerged,
                      "Work Item PR was merged before the Step Run started",
                      now,
                      workItemId,
                    ],
                  )) as readonly { readonly queue_job_id: string | null }[]
                  for (const cancelled of lateQueued) {
                    if (cancelled.queue_job_id !== null) {
                      yield* queue
                        .acknowledge(cancelled.queue_job_id)
                        .pipe(
                          Effect.catchTag(
                            "JobNotFoundError",
                            () => Effect.void,
                          ),
                        )
                    }
                  }

                  const updated = (yield* sql.unsafe(
                    `UPDATE work_item
                   SET state = 'local_cleanup',
                       state_ready_at = ?,
                       paused = 0,
                       failure_code = NULL,
                       failure_message = NULL,
                       updated_at = ?
                   WHERE id = ?
                     AND state NOT IN ('complete', 'failed', 'abandoned', 'local_cleanup')
                   RETURNING id`,
                    [now, now, workItemId],
                  )) as readonly { readonly id: string }[]

                  if (!updated[0]) {
                    return yield* new NeedsHumanHandoffNotEligibleError({
                      workItemId,
                      reason:
                        "Work Item is no longer eligible for merge cleanup advance",
                    })
                  }

                  const acquired = yield* tryAcquireWorkerSlot(workItemId, now)
                  if (!acquired) {
                    return
                  }

                  const stillActive = (yield* sql.unsafe(
                    `SELECT id FROM step_run
                   WHERE work_item_id = ?
                     AND status IN ('queued', 'running')
                   LIMIT 1`,
                    [workItemId],
                  )) as readonly { readonly id: string }[]
                  if (stillActive[0]) {
                    return
                  }

                  yield* enqueueStepRunForWorkItem(
                    workItemId,
                    "local_cleanup",
                    now,
                  )
                }).pipe((mutation) =>
                  applyLifecycleTransition(
                    workItemId,
                    "local_cleanup",
                    mutation,
                    () => true,
                  ),
                )
              }),
            )
            .pipe(Effect.catch(mapContinueAfterHumanPrOutcomeTransactionError))

          const resumed = yield* getWorkItem(workItemId).pipe(
            Effect.catchTag(
              "WorkItemNotFoundError",
              (error) =>
                new WorkItemLifecycleDatabaseError({
                  message: `Work Item missing after human merge resume: ${error.workItemId}`,
                  cause: error,
                }),
            ),
          )
          yield* notifyWorkItemsChanged(resumed.repositoryId)
          return resumed
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => mergeSupersedingWorkItems.delete(workItemId)),
          ),
        )
      })

      const reset = Effect.fn("WorkItemLifecycle.reset")(function* (
        workItemId: string,
      ) {
        const workItem = yield* loadWorkItemRow(workItemId)
        if (!workItem) {
          return yield* new WorkItemNotFoundError({ workItemId })
        }

        yield* Effect.sync(() => resettingWorkItems.add(workItemId))

        return yield* Effect.gen(function* () {
          const activeExecutions = [...activeStepExecutions.values()].filter(
            (execution) => execution.workItemId === workItemId,
          )
          yield* Effect.forEach(
            activeExecutions,
            ({ cancel }) => Deferred.succeed(cancel, undefined),
            { discard: true },
          )
          yield* Effect.forEach(
            activeExecutions,
            ({ finished }) => Deferred.await(finished),
            { discard: true },
          )

          const currentWorkItem = yield* loadWorkItemRow(workItemId)
          if (!currentWorkItem) {
            return yield* new WorkItemNotFoundError({ workItemId })
          }

          const cleanupContext = toLifecycleStepContext(currentWorkItem)

          yield* steps.removeWorktree(cleanupContext).pipe(
            Effect.mapError((cause) =>
              isGitHubThrottledError(cause)
                ? cause
                : new ResetCleanupError({
                    workItemId,
                    message: `Failed to remove worktree for Work Item ${workItemId}`,
                    cause,
                  }),
            ),
          )

          const now = yield* Clock.currentTimeMillis

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const current = yield* loadWorkItemRow(workItemId)
                if (!current) {
                  return yield* new WorkItemNotFoundError({ workItemId })
                }

                const activeJobs = (yield* sql.unsafe(
                  `SELECT id, status, queue_job_id FROM step_run
                 WHERE work_item_id = ?
                   AND status IN ('queued', 'running')`,
                  [workItemId],
                )) as readonly {
                  readonly id: string
                  readonly status: string
                  readonly queue_job_id: string | null
                }[]

                yield* sql.unsafe(
                  `UPDATE step_run
                 SET status = 'interrupted',
                     finished_at = COALESCE(finished_at, ?),
                     reason_code = ?,
                     reason_message = ?,
                     updated_at = ?
                 WHERE work_item_id = ? AND status = 'running'`,
                  [
                    now,
                    STEP_RUN_REASON.reset,
                    "Work Item was reset while the Step Run was Running",
                    now,
                    workItemId,
                  ],
                )

                yield* sql.unsafe(
                  `UPDATE step_run
                 SET status = 'cancelled',
                     finished_at = ?,
                     reason_code = ?,
                     reason_message = ?,
                     updated_at = ?
                 WHERE work_item_id = ? AND status = 'queued'`,
                  [
                    now,
                    STEP_RUN_REASON.reset,
                    "Work Item was reset before the Step Run started",
                    now,
                    workItemId,
                  ],
                )

                for (const active of activeJobs) {
                  if (active.queue_job_id !== null) {
                    yield* queue
                      .acknowledge(active.queue_job_id)
                      .pipe(
                        Effect.catchTag("JobNotFoundError", () => Effect.void),
                      )
                  }
                }

                yield* sql.unsafe(
                  `DELETE FROM step_run WHERE work_item_id = ?`,
                  [workItemId],
                )
                yield* sql.unsafe(`DELETE FROM work_item WHERE id = ?`, [
                  workItemId,
                ])
              }),
            )
            .pipe(
              Effect.catch((error): Effect.Effect<never, ResetError> => {
                if (error instanceof WorkItemNotFoundError) {
                  return Effect.fail(error)
                }
                if (error instanceof WorkItemLifecycleDatabaseError) {
                  return Effect.fail(error)
                }
                if (
                  typeof error === "object" &&
                  error !== null &&
                  "_tag" in error &&
                  ((error as { _tag: string })._tag === "AcknowledgeError" ||
                    (error as { _tag: string })._tag === "JobNotFoundError")
                ) {
                  return Effect.fail(
                    error as AcknowledgeError | JobNotFoundError,
                  )
                }
                if (
                  typeof error === "object" &&
                  error !== null &&
                  "_tag" in error &&
                  (error as { _tag: string })._tag === "SqlError"
                ) {
                  return Effect.fail(toDatabaseError(error as SqlError))
                }
                return Effect.fail(
                  new WorkItemLifecycleDatabaseError({
                    message: `Unexpected transaction failure: ${String(error)}`,
                    cause: error,
                  }),
                )
              }),
            )

          yield* notifyWorkItemsChanged(workItem.repository_id)
          yield* admitWaitingWorkItems.pipe(
            Effect.catch((error) =>
              Effect.logError("Failed to admit waiters after reset", {
                error: String(error),
              }),
            ),
          )
          return workItem.id as WorkItemId
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => resettingWorkItems.delete(workItemId)),
          ),
        )
      })

      const retry = Effect.fn("WorkItemLifecycle.retry")(function* (
        workItemId: string,
      ) {
        const workItem = yield* loadWorkItemRow(workItemId)
        if (!workItem) {
          return yield* new WorkItemNotFoundError({ workItemId })
        }

        const recoverableStatusCheckFailure =
          workItem.state === "failed" &&
          workItem.failure_code === "pr_status_checks_unresolved"

        const latestRows = (yield* sql
          .unsafe(
            `SELECT ${STEP_RUN_SELECT_COLUMNS}
             FROM step_run
             WHERE work_item_id = ?
             ORDER BY queued_at DESC, rowid DESC
             LIMIT 1`,
            [workItemId],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly StepRunRow[]
        const latest = latestRows[0]
        const retryableInvestigateNeedsHuman =
          workItem.state === "needs_human" &&
          latest?.step === "investigate_pr_status_checks" &&
          latest.status === "succeeded"
        const retryableReviewFixLimitNeedsHuman =
          workItem.state === "needs_human" &&
          latest?.step === "review" &&
          latest.status === "succeeded"
        const retryableNeedsHumanHandoff =
          retryableInvestigateNeedsHuman || retryableReviewFixLimitNeedsHuman

        if (
          isTerminalWorkItemState(workItem.state) &&
          !recoverableStatusCheckFailure &&
          !retryableNeedsHumanHandoff
        ) {
          return yield* new WorkItemTerminalError({
            workItemId,
            state: workItem.state,
          })
        }

        if (workItem.paused) {
          return yield* new RetryNotEligibleError({
            workItemId,
            reason: "paused",
          })
        }

        const pendingStep: OperationalLifecycleStep =
          recoverableStatusCheckFailure
            ? "watch_pr_status_checks"
            : retryableInvestigateNeedsHuman
              ? "investigate_pr_status_checks"
              : retryableReviewFixLimitNeedsHuman
                ? "review"
                : (workItem.state as OperationalLifecycleStep)

        const activeRows = (yield* sql
          .unsafe(
            `SELECT ${STEP_RUN_SELECT_COLUMNS}
           FROM step_run
           WHERE work_item_id = ?
             AND status IN ('queued', 'running')
           ORDER BY queued_at DESC, rowid DESC
           LIMIT 1`,
            [workItemId],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly StepRunRow[]

        const active = activeRows[0]
        if (active) {
          return yield* new ActiveStepRunExistsError({
            workItemId,
            stepRunId: active.id,
            status: active.status,
          })
        }

        if (!recoverableStatusCheckFailure && !retryableNeedsHumanHandoff) {
          const latestPendingRows = (yield* sql
            .unsafe(
              `SELECT ${STEP_RUN_SELECT_COLUMNS}
             FROM step_run
             WHERE work_item_id = ?
               AND step = ?
             ORDER BY queued_at DESC, rowid DESC
             LIMIT 1`,
              [workItemId, pendingStep],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly StepRunRow[]

          const latest = latestPendingRows[0]
          if (!latest) {
            return yield* new RetryNotEligibleError({
              workItemId,
              reason: "no_prior_step_run",
            })
          }

          if (latest.status !== "failed" && latest.status !== "interrupted") {
            return yield* new RetryNotEligibleError({
              workItemId,
              reason: `latest_status_${latest.status}`,
            })
          }
        }

        const now = yield* Clock.currentTimeMillis

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (recoverableStatusCheckFailure || retryableNeedsHumanHandoff) {
                // Retryable unresolved-check failures may predate Check-Start
                // Anchor columns; give them a conservative anchor before Watch.
                yield* sql.unsafe(
                  `UPDATE work_item
               SET state = ?,
                   state_ready_at = ?,
                   failure_code = NULL,
                   failure_message = NULL,
                   check_start_anchor_at = CASE
                     WHEN ? = 1 AND check_start_anchor_at IS NULL THEN ?
                     ELSE check_start_anchor_at
                   END,
                   updated_at = ?
               WHERE id = ?`,
                  [
                    pendingStep,
                    now,
                    recoverableStatusCheckFailure ? 1 : 0,
                    now,
                    now,
                    workItemId,
                  ],
                )
              }

              if (
                retryableInvestigateNeedsHuman &&
                latest !== undefined &&
                latest.finished_at !== null
              ) {
                yield* sql.unsafe(
                  `UPDATE pr_status_check
               SET handled_at = NULL, handled_by_step_run_id = NULL, updated_at = ?
               WHERE work_item_id = ? AND handled_by_step_run_id = ?`,
                  [now, workItemId, latest.id],
                )
              }

              const acquired = yield* tryAcquireWorkerSlot(workItemId, now)
              if (!acquired) {
                return
              }

              yield* enqueueStepRunForWorkItem(workItemId, pendingStep, now)

              yield* sql.unsafe(
                `UPDATE work_item
               SET updated_at = ?
               WHERE id = ?`,
                [now, workItemId],
              )
            }).pipe((mutation) =>
              recoverableStatusCheckFailure || retryableNeedsHumanHandoff
                ? applyLifecycleTransition(
                    workItemId,
                    pendingStep,
                    mutation,
                    () => true,
                  )
                : mutation,
            ),
          )
          .pipe(
            Effect.catch((error): Effect.Effect<never, RetryError> => {
              if (error instanceof WorkItemLifecycleDatabaseError) {
                return Effect.fail(error)
              }
              if (error instanceof EnqueueError) {
                return Effect.fail(error)
              }
              if (error instanceof InvalidQueueNameError) {
                return Effect.fail(error)
              }
              if (
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                (error as { _tag: string })._tag === "SqlError"
              ) {
                const sqlError = error as SqlError
                if (isActiveStepRunUniqueViolation(sqlError)) {
                  return Effect.gen(function* () {
                    const conflict = (yield* sql
                      .unsafe(
                        `SELECT id, status FROM step_run
                       WHERE work_item_id = ?
                         AND status IN ('queued', 'running')
                       ORDER BY queued_at DESC, rowid DESC
                       LIMIT 1`,
                        [workItemId],
                      )
                      .pipe(Effect.mapError(toDatabaseError))) as readonly {
                      id: string
                      status: string
                    }[]
                    const row = conflict[0]
                    return yield* new ActiveStepRunExistsError({
                      workItemId,
                      stepRunId: row?.id ?? "unknown",
                      status: row?.status ?? "queued",
                    })
                  })
                }
                return Effect.fail(toDatabaseError(sqlError))
              }
              return Effect.fail(
                new WorkItemLifecycleDatabaseError({
                  message: `Unexpected transaction failure: ${String(error)}`,
                  cause: error,
                }),
              )
            }),
          )

        const retried = yield* getWorkItem(workItemId).pipe(
          Effect.catchTag(
            "WorkItemNotFoundError",
            (error) =>
              new WorkItemLifecycleDatabaseError({
                message: `Work Item missing after retry: ${error.workItemId}`,
                cause: error,
              }),
          ),
        )
        yield* notifyWorkItemsChanged(retried.repositoryId)
        return retried
      })

      const createWorkItem = (
        repositoryId: string,
        issueNumber: number,
        options: {
          readonly pauseBeforeStep: OperationalLifecycleStep | null
          readonly mergeMode?: MergeMode
        },
      ): Effect.Effect<WorkItemRecord, ImplementNowError> =>
        Effect.gen(function* () {
          const issues = yield* db.listIssues(repositoryId)
          const issue = issues.find(
            (candidate) => candidate.issueNumber === issueNumber,
          )
          const currentIssue = currentIssuePredicateInput(issue)
          const implementable = evaluateImplementableIssue(currentIssue)
          switch (implementable._tag) {
            case "issue_missing":
              return yield* new IssueNotFoundError({
                repositoryId,
                issueNumber,
              })
            case "issue_not_open":
              return yield* new IssueNotOpenError({
                repositoryId,
                issueNumber,
                state: implementable.state,
              })
            case "issue_not_leaf":
              return yield* new ParentIssueError({
                repositoryId,
                issueNumber,
              })
            case "issue_blocked":
              return yield* new IssueBlockedError({
                repositoryId,
                issueNumber,
                blockerCount: implementable.blockerCount,
              })
          }
          const matchedIssue = Option.getOrThrow(Option.fromNullishOr(issue))

          const existing = yield* listWorkItemsForIssue(
            repositoryId,
            issueNumber,
          )
          const actionable = evaluateActionableIssue(
            currentIssue,
            existing.map(workItemPredicateInput),
          )
          if (actionable._tag === "unfinished_work_item_exists") {
            return yield* unfinishedWorkItemExistsError(
              repositoryId,
              issueNumber,
              actionable.workItemId ?? undefined,
            )
          }

          const mergeMode: MergeMode = options.mergeMode ?? "ordinary"

          // Coordinate with Config hot-activate so provenance cannot be captured
          // while Selected is already switching Active. Fail-fast model resolve
          // runs inside the same section so it matches the backend that is stamped.
          const createdId = yield* activeAgentBackend.withConfigCoordination(
            Effect.gen(function* () {
              // Effective Agent Backend: Repository override or harness default.
              // Capture it as routing authority for the Work Item lifetime.
              const harnessConfig = yield* db.getConfig
              const repositories = yield* db.listRepositories
              const repository = repositories.find(
                ({ id }) => id === repositoryId,
              )
              const rawCaptureBackendId =
                repository?.selectedAgentBackend ??
                harnessConfig.selectedAgentBackend
              if (!isSelectableAgentBackendId(rawCaptureBackendId)) {
                return yield* new AgentBackendUnavailableError({
                  message: `Unknown or unsupported Agent Backend: ${rawCaptureBackendId}`,
                  reason: `Unknown or unsupported Agent Backend: ${rawCaptureBackendId}`,
                })
              }
              const captureBackendId = rawCaptureBackendId
              yield* activeAgentBackend
                .requireAgentTurnsAllowed(captureBackendId)
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new AgentBackendUnavailableError({
                        message: error.message,
                        reason: error.reason,
                      }),
                  ),
                )
              // Models are not stored on the Work Item; resolve against the
              // captured backend's prefs after coordination has locked the switch.
              const capturedSelection = yield* resolveModelsForBackend(
                repositoryId,
                captureBackendId,
              )
              // Catalog admission (issue #838): refuse to create a Work Item
              // whose resolved models the captured backend no longer offers,
              // so the failure surfaces at the operator action rather than as
              // a dead Agent Turn later.
              const captureStatus =
                yield* activeAgentBackend.getBackendStatus(captureBackendId)
              if (captureStatus !== null && captureStatus.kind === "ready") {
                const violation = agentModelCatalogViolation({
                  backendLabel: captureStatus.backend.label,
                  catalogModelIds: captureStatus.models.map(
                    (model) => model.id,
                  ),
                  selection: capturedSelection,
                  includeReviewModel: true,
                })
                if (violation !== null) {
                  return yield* new BuildModelNotConfiguredError({
                    message: violation,
                  })
                }
              }
              const activeRegistration =
                yield* activeAgentBackend.getRegistration(captureBackendId)
              const agentBackendId = activeRegistration.descriptor.id
              const workItemId = makeWorkItemId()
              const now = yield* Clock.currentTimeMillis
              const step: OperationalLifecycleStep = "create_worktree"

              return yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    const limit = yield* maxWorkerSlots()
                    const occupied = yield* countOccupiedWorkerSlots()
                    const admit = occupied < limit

                    yield* sql.unsafe(
                      `INSERT INTO work_item (
                 id, repository_id, issue_number, agent_backend,
                  issue_title, state, state_ready_at, paused,
                  waiting_since, waiting_for_blockers, merge_mode, holds_worker_slot,
                  pause_before_step, worktree_path, session_id, failure_code,
                  failure_message, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
                      [
                        workItemId,
                        repositoryId,
                        issueNumber,
                        agentBackendId,
                        matchedIssue.title,
                        step,
                        now,
                        admit ? null : now,
                        mergeMode,
                        admit ? 1 : 0,
                        options.pauseBeforeStep,
                        now,
                        now,
                      ],
                    )

                    if (admit) {
                      yield* enqueueStepRunForWorkItem(workItemId, step, now)
                    }

                    return workItemId
                  }),
                )
                .pipe(
                  Effect.catch(
                    (error): Effect.Effect<never, ImplementNowError> => {
                      if (error instanceof WorkItemLifecycleDatabaseError) {
                        return Effect.fail(error)
                      }
                      if (error instanceof EnqueueError) {
                        return Effect.fail(error)
                      }
                      if (error instanceof InvalidQueueNameError) {
                        return Effect.fail(error)
                      }
                      if (
                        typeof error === "object" &&
                        error !== null &&
                        "_tag" in error &&
                        (error as { _tag: string })._tag === "SqlError"
                      ) {
                        const sqlError = error as SqlError
                        if (isUnfinishedWorkItemUniqueViolation(sqlError)) {
                          return unfinishedWorkItemExistsError(
                            repositoryId,
                            issueNumber,
                          )
                        }
                        return Effect.fail(toDatabaseError(sqlError))
                      }
                      return Effect.fail(
                        new WorkItemLifecycleDatabaseError({
                          message: `Unexpected transaction failure: ${String(error)}`,
                          cause: error,
                        }),
                      )
                    },
                  ),
                )
            }),
          )

          const created = yield* getWorkItem(createdId).pipe(
            Effect.catchTag(
              "WorkItemNotFoundError",
              (error) =>
                new WorkItemLifecycleDatabaseError({
                  message: `Work Item missing after create: ${error.workItemId}`,
                  cause: error,
                }),
            ),
          )
          yield* notifyWorkItemsChanged(created.repositoryId)
          return created
        })

      const implementNow = Effect.fn("WorkItemLifecycle.implementNow")(
        function* (repositoryId: string, issueNumber: number) {
          return yield* createWorkItem(repositoryId, issueNumber, {
            pauseBeforeStep: null,
          })
        },
      )

      const implementLocally = Effect.fn("WorkItemLifecycle.implementLocally")(
        function* (repositoryId: string, issueNumber: number) {
          return yield* createWorkItem(repositoryId, issueNumber, {
            pauseBeforeStep: "commit",
          })
        },
      )

      /**
       * Parent command: for every open direct child, either adopt the existing
       * unfinished Work Item (set Merge Mode Always only) or create a new one
       * with Always. Unblocked creates → Implement Now admission; blocked →
       * Queue. Create + adopt in one atomic transaction; failure rolls back
       * both. Does not clear Needs Human or enqueue Merge PR.
       */
      const implementAllWithAutoMerge = Effect.fn(
        "WorkItemLifecycle.implementAllWithAutoMerge",
      )(function* (repositoryId: string, parentIssueNumber: number) {
        const issues = yield* db.listIssues(repositoryId)
        const parent = issues.find(
          (candidate) => candidate.issueNumber === parentIssueNumber,
        )

        if (!parent) {
          return yield* new IssueNotFoundError({
            repositoryId,
            issueNumber: parentIssueNumber,
          })
        }

        if (!parent.hasChildren) {
          return yield* new NotAParentIssueError({
            repositoryId,
            issueNumber: parentIssueNumber,
          })
        }

        const children = issues.filter(
          (candidate) =>
            candidate.parent !== null &&
            candidate.parent.issueNumber === parentIssueNumber,
        )

        if (children.some((child) => child.hasChildren)) {
          return yield* new UnsupportedIssueHierarchyError({
            repositoryId,
            issueNumber: parentIssueNumber,
            message: `Issue #${parentIssueNumber} has grandchildren and is not a Supported Issue Hierarchy`,
          })
        }

        // Snapshot open direct children at acceptance; closed children and
        // children added later are out of scope for this request.
        const openChildren = children
          .filter((child) => child.state === "OPEN")
          .slice()
          .sort((a, b) => {
            const aPos = a.parentPosition ?? Number.MAX_SAFE_INTEGER
            const bPos = b.parentPosition ?? Number.MAX_SAFE_INTEGER
            if (aPos !== bPos) return aPos - bPos
            return a.issueNumber - b.issueNumber
          })

        if (openChildren.length === 0) {
          return yield* new ImplementAllWithAutoMergeNotEligibleError({
            repositoryId,
            issueNumber: parentIssueNumber,
            reason: `Parent Issue #${parentIssueNumber} has no open Child Issues`,
          })
        }

        // Pre-scan only decides whether any create may need Agent Backend
        // resolution. The transaction re-reads unfinished rows so concurrent
        // create/abandon races stay all-or-nothing.
        const repositoryWorkItems =
          yield* listWorkItemsForRepository(repositoryId)
        const unfinishedByIssue = new Map<number, WorkItemId>()
        for (const item of repositoryWorkItems) {
          if (
            evaluateUnfinishedWorkItem(workItemPredicateInput(item))._tag ===
            "match"
          ) {
            unfinishedByIssue.set(item.issueNumber, item.id)
          }
        }

        const mayNeedCreate = openChildren.some(
          (child) => !unfinishedByIssue.has(child.issueNumber),
        )

        const mapTransactionError = (
          error: unknown,
        ): Effect.Effect<never, ImplementAllWithAutoMergeError> => {
          if (error instanceof WorkItemLifecycleDatabaseError) {
            return Effect.fail(error)
          }
          if (error instanceof EnqueueError) {
            return Effect.fail(error)
          }
          if (error instanceof InvalidQueueNameError) {
            return Effect.fail(error)
          }
          if (error instanceof AgentBackendUnavailableError) {
            return Effect.fail(error)
          }
          if (error instanceof BuildModelNotConfiguredError) {
            return Effect.fail(error)
          }
          // Domain eligibility failures raised inside the transaction (e.g.
          // pure-adopt concurrent abandon) must keep their tag for GraphQL.
          if (error instanceof ImplementAllWithAutoMergeNotEligibleError) {
            return Effect.fail(error)
          }
          if (
            typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            (error as { _tag: string })._tag === "SqlError"
          ) {
            const sqlError = error as SqlError
            if (isUnfinishedWorkItemUniqueViolation(sqlError)) {
              return Effect.fail(
                new ImplementAllWithAutoMergeNotEligibleError({
                  repositoryId,
                  issueNumber: parentIssueNumber,
                  reason: `A concurrent request enrolled a Child Issue of Parent Issue #${parentIssueNumber}`,
                }),
              )
            }
            return Effect.fail(toDatabaseError(sqlError))
          }
          return Effect.fail(
            new WorkItemLifecycleDatabaseError({
              message: `Unexpected transaction failure: ${String(error)}`,
              cause: error,
            }),
          )
        }

        const enrollOpenChildren = (
          agentBackendId: string | null,
        ): Effect.Effect<
          readonly WorkItemId[],
          ImplementAllWithAutoMergeError
        > =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const step: OperationalLifecycleStep = "create_worktree"

            return yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const limit = yield* maxWorkerSlots()
                  let occupied = yield* countOccupiedWorkerSlots()
                  const workItemIds: WorkItemId[] = []

                  for (const child of openChildren) {
                    const unfinishedRows = (yield* sql
                      .unsafe(
                        `SELECT id FROM work_item
                         WHERE repository_id = ?
                           AND issue_number = ?
                           AND state NOT IN ('complete', 'failed', 'abandoned')
                         LIMIT 1`,
                        [repositoryId, child.issueNumber],
                      )
                      .pipe(Effect.mapError(toDatabaseError))) as readonly {
                      readonly id: string
                    }[]

                    const existingId = unfinishedRows[0]?.id
                    if (existingId !== undefined) {
                      // Adopt only: durable Merge Mode Always. Do not touch
                      // state, admission, Step Runs, Session, worktree, PR, or
                      // Needs Human handoff. RETURNING rejects a concurrent
                      // terminal transition so we never report a false adopt.
                      const adoptedRows = (yield* sql
                        .unsafe(
                          `UPDATE work_item
                           SET merge_mode = 'always', updated_at = ?
                           WHERE id = ?
                             AND state NOT IN ('complete', 'failed', 'abandoned')
                           RETURNING id`,
                          [now, existingId],
                        )
                        .pipe(Effect.mapError(toDatabaseError))) as readonly {
                        readonly id: string
                      }[]
                      if (adoptedRows[0]?.id === undefined) {
                        return yield* new ImplementAllWithAutoMergeNotEligibleError(
                          {
                            repositoryId,
                            issueNumber: parentIssueNumber,
                            reason: `A concurrent request changed a Child Issue of Parent Issue #${parentIssueNumber}`,
                          },
                        )
                      }
                      workItemIds.push(existingId as WorkItemId)
                      continue
                    }

                    if (agentBackendId === null) {
                      // Race: pre-scan expected pure adopt, but a concurrent
                      // abandon left this child without an unfinished WI.
                      return yield* new ImplementAllWithAutoMergeNotEligibleError(
                        {
                          repositoryId,
                          issueNumber: parentIssueNumber,
                          reason: `A concurrent request changed a Child Issue of Parent Issue #${parentIssueNumber}`,
                        },
                      )
                    }

                    const workItemId = makeWorkItemId()
                    const blocked = child.blockedBy.length > 0

                    if (blocked) {
                      yield* sql.unsafe(
                        `INSERT INTO work_item (
                     id, repository_id, issue_number, agent_backend,
                      issue_title, state, state_ready_at, paused,
                      waiting_since, waiting_for_blockers, merge_mode, holds_worker_slot,
                      pause_before_step, worktree_path, session_id, failure_code,
                      failure_message, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, 'always', 0, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
                        [
                          workItemId,
                          repositoryId,
                          child.issueNumber,
                          agentBackendId,
                          child.title,
                          step,
                          now,
                          now,
                          now,
                        ],
                      )
                    } else {
                      const admit = occupied < limit
                      yield* sql.unsafe(
                        `INSERT INTO work_item (
                     id, repository_id, issue_number, agent_backend,
                      issue_title, state, state_ready_at, paused,
                      waiting_since, waiting_for_blockers, merge_mode, holds_worker_slot,
                      pause_before_step, worktree_path, session_id, failure_code,
                      failure_message, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 'always', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
                        [
                          workItemId,
                          repositoryId,
                          child.issueNumber,
                          agentBackendId,
                          child.title,
                          step,
                          now,
                          admit ? null : now,
                          admit ? 1 : 0,
                          now,
                          now,
                        ],
                      )
                      if (admit) {
                        occupied += 1
                        yield* enqueueStepRunForWorkItem(workItemId, step, now)
                      }
                    }

                    workItemIds.push(workItemId)
                  }

                  return workItemIds
                }),
              )
              .pipe(Effect.catch(mapTransactionError))
          })

        const coveredIds = mayNeedCreate
          ? yield* activeAgentBackend.withConfigCoordination(
              Effect.gen(function* () {
                const harnessConfig = yield* db.getConfig
                const repositories = yield* db.listRepositories
                const repository = repositories.find(
                  ({ id }) => id === repositoryId,
                )
                const rawCaptureBackendId =
                  repository?.selectedAgentBackend ??
                  harnessConfig.selectedAgentBackend
                if (!isSelectableAgentBackendId(rawCaptureBackendId)) {
                  return yield* new AgentBackendUnavailableError({
                    message: `Unknown or unsupported Agent Backend: ${rawCaptureBackendId}`,
                    reason: `Unknown or unsupported Agent Backend: ${rawCaptureBackendId}`,
                  })
                }
                const captureBackendId = rawCaptureBackendId
                yield* activeAgentBackend
                  .requireAgentTurnsAllowed(captureBackendId)
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new AgentBackendUnavailableError({
                          message: error.message,
                          reason: error.reason,
                        }),
                    ),
                  )
                yield* resolveModelsForBackend(repositoryId, captureBackendId)
                const activeRegistration =
                  yield* activeAgentBackend.getRegistration(captureBackendId)
                const agentBackendId = activeRegistration.descriptor.id
                return yield* enrollOpenChildren(agentBackendId)
              }),
            )
          : yield* enrollOpenChildren(null)

        const covered = yield* Effect.forEach(
          coveredIds,
          (workItemId) =>
            getWorkItem(workItemId).pipe(
              Effect.catchTag(
                "WorkItemNotFoundError",
                (error) =>
                  new WorkItemLifecycleDatabaseError({
                    message: `Work Item missing after implement-all adopt/create: ${error.workItemId}`,
                    cause: error,
                  }),
              ),
            ),
          { concurrency: 1 },
        )
        yield* notifyWorkItemsChanged(repositoryId)
        return covered
      })

      const queueIssue = Effect.fn("WorkItemLifecycle.queue")(function* (
        repositoryId: string,
        issueNumber: number,
      ) {
        const issues = yield* db.listIssues(repositoryId)
        const issue = issues.find(
          (candidate) => candidate.issueNumber === issueNumber,
        )
        const implementable = evaluateImplementableIssue(
          currentIssuePredicateInput(issue),
        )
        switch (implementable._tag) {
          case "issue_missing":
            return yield* new IssueNotFoundError({
              repositoryId,
              issueNumber,
            })
          case "issue_not_open":
            return yield* new IssueNotOpenError({
              repositoryId,
              issueNumber,
              state: implementable.state,
            })
          case "issue_not_leaf":
            return yield* new ParentIssueError({
              repositoryId,
              issueNumber,
            })
          case "match":
            return yield* new IssueNotBlockedError({
              repositoryId,
              issueNumber,
            })
          case "issue_blocked":
            break
        }
        const matchedIssue = Option.getOrThrow(Option.fromNullishOr(issue))

        const existing = yield* listWorkItemsForIssue(repositoryId, issueNumber)
        const unfinished = existing.find(
          (item) =>
            evaluateUnfinishedWorkItem(workItemPredicateInput(item))._tag ===
            "match",
        )
        if (unfinished) {
          return yield* unfinishedWorkItemExistsError(
            repositoryId,
            issueNumber,
            unfinished.id,
          )
        }

        const createdId = yield* activeAgentBackend.withConfigCoordination(
          Effect.gen(function* () {
            const harnessConfig = yield* db.getConfig
            const repositories = yield* db.listRepositories
            const repository = repositories.find(
              ({ id }) => id === repositoryId,
            )
            const rawCaptureBackendId =
              repository?.selectedAgentBackend ??
              harnessConfig.selectedAgentBackend
            if (!isSelectableAgentBackendId(rawCaptureBackendId)) {
              return yield* new AgentBackendUnavailableError({
                message: `Unknown or unsupported Agent Backend: ${rawCaptureBackendId}`,
                reason: `Unknown or unsupported Agent Backend: ${rawCaptureBackendId}`,
              })
            }
            const captureBackendId = rawCaptureBackendId
            yield* activeAgentBackend
              .requireAgentTurnsAllowed(captureBackendId)
              .pipe(
                Effect.mapError(
                  (error) =>
                    new AgentBackendUnavailableError({
                      message: error.message,
                      reason: error.reason,
                    }),
                ),
              )
            yield* resolveModelsForBackend(repositoryId, captureBackendId)
            const activeRegistration =
              yield* activeAgentBackend.getRegistration(captureBackendId)
            const agentBackendId = activeRegistration.descriptor.id
            const workItemId = makeWorkItemId()
            const now = yield* Clock.currentTimeMillis
            const step: OperationalLifecycleStep = "create_worktree"

            return yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* sql.unsafe(
                    `INSERT INTO work_item (
                 id, repository_id, issue_number, agent_backend,
                  issue_title, state, state_ready_at, paused,
                  waiting_since, waiting_for_blockers, merge_mode, holds_worker_slot,
                  pause_before_step, worktree_path, session_id, failure_code,
                  failure_message, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, 'ordinary', 0, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
                    [
                      workItemId,
                      repositoryId,
                      issueNumber,
                      agentBackendId,
                      matchedIssue.title,
                      step,
                      now,
                      now,
                      now,
                    ],
                  )

                  return workItemId
                }),
              )
              .pipe(
                Effect.catch((error): Effect.Effect<never, QueueError> => {
                  if (error instanceof WorkItemLifecycleDatabaseError) {
                    return Effect.fail(error)
                  }
                  if (
                    typeof error === "object" &&
                    error !== null &&
                    "_tag" in error &&
                    (error as { _tag: string })._tag === "SqlError"
                  ) {
                    const sqlError = error as SqlError
                    if (isUnfinishedWorkItemUniqueViolation(sqlError)) {
                      return unfinishedWorkItemExistsError(
                        repositoryId,
                        issueNumber,
                      )
                    }
                    return Effect.fail(toDatabaseError(sqlError))
                  }
                  return Effect.fail(
                    new WorkItemLifecycleDatabaseError({
                      message: `Unexpected transaction failure: ${String(error)}`,
                      cause: error,
                    }),
                  )
                }),
              )
          }),
        )

        const created = yield* getWorkItem(createdId).pipe(
          Effect.catchTag(
            "WorkItemNotFoundError",
            (error) =>
              new WorkItemLifecycleDatabaseError({
                message: `Work Item missing after queue: ${error.workItemId}`,
                cause: error,
              }),
          ),
        )
        yield* notifyWorkItemsChanged(created.repositoryId)
        return created
      })

      return WorkItemLifecycle.of({
        maxDurations,
        recoverOrphanedStepRuns,
        interruptRunningStepRunsFromPriorWorker,
        implementNow,
        implementLocally,
        implementAllWithAutoMerge,
        queue: queueIssue,
        runStep,
        wakePostponedStep,
        retry,
        pause,
        start,
        abandon,
        reset,
        getWorkItem,
        listWorkItemsForIssue,
        listWorkItemsForRepository,
        listCompletedWorkItems,
        ownsSessionId,
        countCommittedPullRequests,
        continueAfterHumanPrOutcome,
        admitWaitingWorkItems,
        releaseWaitingForBlockers,
      })
    }),
  )

export const WorkItemLifecycleLive = makeWorkItemLifecycleLive()
