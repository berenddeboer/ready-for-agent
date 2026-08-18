import { Schema } from "effect"
import { ulid } from "ulidx"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  type LifecycleMaxDurations,
  OperationalLifecycleStep,
  STEP_RUN_REASON,
  TERMINAL_WORK_ITEM_STATES,
  TerminalWorkItemState,
  WorkItemState,
} from "@ready-for-agent/lifecycle-model"
import type { ExplicitWorkItemExecutionProfile } from "./execution-profile.js"
import {
  COMPLETED_WORK_ITEMS_DEFAULT_PAGE_SIZE,
  COMPLETED_WORK_ITEMS_MAX_PAGE_SIZE,
  JOBS_COMPLETED_WINDOW_HOURS,
  JOBS_COMPLETED_WINDOW_MS,
} from "./jobs-completed-window.js"

export {
  STEP_RUN_REASON,
  type StepRunReasonCode,
} from "@ready-for-agent/lifecycle-model"
export type {
  ExecutionProfileReviewSelection,
  ExplicitWorkItemExecutionProfile,
  ImplementWithOptionsInput,
  ImplementWithProfileInput,
} from "./execution-profile.js"
export { decodeImplementWithOptions } from "./execution-profile.js"
export {
  COMPLETED_WORK_ITEMS_DEFAULT_PAGE_SIZE,
  COMPLETED_WORK_ITEMS_MAX_PAGE_SIZE,
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  JOBS_COMPLETED_WINDOW_HOURS,
  JOBS_COMPLETED_WINDOW_MS,
  type LifecycleMaxDurations,
  OperationalLifecycleStep,
  TERMINAL_WORK_ITEM_STATES,
  TerminalWorkItemState,
  WorkItemState,
}

export const WorkItemId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^wi-[0-9A-HJKMNP-TV-Z]{26}$/)),
  Schema.brand("WorkItemId"),
)
export type WorkItemId = typeof WorkItemId.Type

export const makeWorkItemId = (): WorkItemId => WorkItemId.make(`wi-${ulid()}`)

export const StepRunId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^srun-[0-9A-HJKMNP-TV-Z]{26}$/)),
  Schema.brand("StepRunId"),
)
export type StepRunId = typeof StepRunId.Type

export const makeStepRunId = (): StepRunId => StepRunId.make(`srun-${ulid()}`)

export const makeAutonomousRetryId = (): string => `artry-${ulid()}`

export const StepRunStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
  "postponed",
])
export type StepRunStatus = typeof StepRunStatus.Type

/**
 * Durable Work Item merge policy.
 * `ordinary` follows Repository Auto-merge and Decide PR Merge.
 * `always` skips Decide PR Merge after pre-merge lifecycle settles.
 */
export const MergeMode = Schema.Literals(["ordinary", "always"])
export type MergeMode = typeof MergeMode.Type

interface StepRunRecordBase {
  readonly id: StepRunId
  readonly workItemId: WorkItemId
  readonly step: OperationalLifecycleStep
  readonly queueJobId: string | null
  readonly queuedAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  readonly reasonCode: string | null
  readonly reasonMessage: string | null
  /**
   * JSON diagnostic payload for failed Step Runs (cause chain + machine
   * code). Null when nothing was persisted.
   */
  readonly reasonDetail: string | null
  /** Time from queued until start (or finish/now if never started). */
  readonly queueWaitMs: number
  /** Time from start until finish/now; null when execution never began. */
  readonly executionDurationMs: number | null
}

/** A finished attempt held for GitHub's durable retry deadline. */
export type PostponedStepRunRecord = Omit<StepRunRecordBase, "finishedAt"> & {
  readonly status: "postponed"
  readonly finishedAt: Date
  readonly postponedUntil: Date
}

/** Every non-postponed outcome has no GitHub retry deadline. */
export type NonPostponedStepRunRecord = StepRunRecordBase & {
  readonly status: Exclude<StepRunStatus, "postponed">
  readonly postponedUntil: null
}

/**
 * A persisted Step Run makes its outcome/deadline invariant unrepresentable
 * in lifecycle code; the SQLite migration enforces the same contract.
 */
export type StepRunRecord = PostponedStepRunRecord | NonPostponedStepRunRecord

export interface WorkItemRecord {
  readonly id: WorkItemId
  readonly repositoryId: string
  readonly issueNumber: number
  readonly issueTitle: string | null
  readonly pullRequestNumber: number | null
  /**
   * Effective Agent Backend captured at creation: provenance and routing
   * authority for Agent Turns and model resolution for the Work Item lifetime.
   */
  readonly agentBackend: string
  /**
   * Immutable Explicit Work Item Execution Profile when created through
   * Implement With. Null for ordinary settings-resolved Work Items.
   */
  readonly executionProfile: ExplicitWorkItemExecutionProfile | null
  readonly state: WorkItemState
  readonly stateReadyAt: Date
  readonly paused: boolean
  /**
   * When set, the Work Item is Waiting for Worker Slot (FIFO by this timestamp).
   */
  readonly waitingSince: Date | null
  /**
   * When true, the Work Item is Waiting for blockers (Queue hold). No Worker
   * Slot, no Step Run, and Pause/Start are rejected until the hold lifts.
   */
  readonly waitingForBlockers: boolean
  /**
   * Durable merge policy. `always` skips Decide PR Merge; `ordinary` does not.
   */
  readonly mergeMode: MergeMode
  /**
   * Work Item Auto-merge override. Null follows the live Repository
   * Auto-merge setting; true/false is a concrete Decide PR Merge policy.
   */
  readonly autoMergeOverride: boolean | null
  /** Whether this Work Item currently occupies a Worker Slot (Admitted). */
  readonly holdsWorkerSlot: boolean
  /** When set, advancement into this step auto-pauses (no Step Run enqueued). */
  readonly pauseBeforeStep: OperationalLifecycleStep | null
  readonly worktreePath: string | null
  /** Exact commit OID recorded by Create Worktree for Assess Changes. */
  readonly startingCommitOid: string | null
  /** Durable No-Change Outcome completion summary (Markdown). */
  readonly completionSummary: string | null
  /**
   * Canonical publication title for Commit subject and PR title.
   * Null until Commit generates, seeds, or falls back to harness copy.
   */
  readonly publicationTitle: string | null
  /**
   * Canonical publication body for Commit body and PR body.
   * Null until Commit generates, seeds, or falls back to harness copy.
   */
  readonly publicationBody: string | null
  readonly sessionId: string | null
  readonly failureCode: string | null
  readonly failureMessage: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  /** Time the Work Item has spent in its current Lifecycle Step (from stateReadyAt). */
  readonly stateResidenceMs: number
  readonly stepRuns: readonly StepRunRecord[]
}

/** Operator-visible message while Waiting for Worker Slot. */
export const WAITING_FOR_WORKER_SLOT_MESSAGE =
  "Waiting for a worker slot to become available"

/**
 * Operator-facing copy for Waiting for blockers.
 * Lists live blocker numbers when provided; otherwise a generic hold message.
 */
export const formatWaitingForBlockersMessage = (
  blockerIssueNumbers: readonly number[] = [],
): string => {
  if (blockerIssueNumbers.length === 0) {
    return "Queued — waiting for blockers"
  }
  const listed = blockerIssueNumbers.map((n) => `#${n}`).join(", ")
  return `Queued — waiting for ${listed}`
}

/** Operator-visible message while a running Step Run waits for an Agent Turn slot. */
export const WAITING_FOR_AGENT_TURN_MESSAGE = "Waiting for an Agent Turn slot"

/** Operator-visible Review phase while the reviewing OpenCode pass runs. */
export const REVIEW_REVIEWING_MESSAGE = "reviewing"

/** Operator-visible Review phase while apply-findings OpenCode pass runs. */
export const REVIEW_APPLYING_FINDINGS_MESSAGE = "applying findings"

/** Operator-visible Review phase while nested Pre-Commit runs after FIXED. */
export const REVIEW_PRE_COMMIT_MESSAGE = "pre-commit"

/** Operator-visible Review phase while Review Rerun Assessment runs. */
export const REVIEW_ASSESSING_RERUN_MESSAGE = "assessing rerun"

/** Operator-visible Commit phase while the publication-copy Agent Turn runs. */
export const COMMIT_COPY_GENERATION_MESSAGE = "generating publication copy"

export const WORK_ITEM_LIFECYCLE_QUEUE = "jobs"

export const WorkItemStepJob = Schema.TaggedStruct("work-item-step", {
  stepRunId: StepRunId,
})
export type WorkItemStepJob = typeof WorkItemStepJob.Type

/**
 * Durable delayed admission request created after GitHub explicitly throttles
 * Watch PR Status Checks. It intentionally is not a Step Run: Waiting for
 * GitHub owns no active attempt until this wake reaches ordinary admission.
 */
export const WorkItemWakeJob = Schema.TaggedStruct("work-item-wake", {
  workItemId: WorkItemId,
  postponedUntil: Schema.Finite,
})
export type WorkItemWakeJob = typeof WorkItemWakeJob.Type

export const isTerminalWorkItemState = (
  state: WorkItemState,
): state is TerminalWorkItemState =>
  (TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(state)

/**
 * Jobs card Completed tab: successful finished outcomes only.
 * Non-retryable terminal `failed` belongs on Failed. Needs Human stays on Working.
 */
export const JOBS_COMPLETED_WORK_ITEM_STATES = [
  "complete",
  "abandoned",
] as const satisfies readonly WorkItemState[]

export type JobsCompletedWorkItemState =
  (typeof JOBS_COMPLETED_WORK_ITEM_STATES)[number]

export const isJobsCompletedWorkItemState = (
  state: WorkItemState,
): state is JobsCompletedWorkItemState =>
  (JOBS_COMPLETED_WORK_ITEM_STATES as readonly string[]).includes(state)

export const RETRYABLE_FAILED_WORK_ITEM_CODE = "pr_status_checks_unresolved"

type JobsListMembershipItem = {
  readonly state: WorkItemState
  readonly failureCode?: string | null
}

/** Persisted terminal status-check failures are retryable for compatibility. */
export const isRetryableFailedWorkItem = (
  item: JobsListMembershipItem,
): boolean =>
  item.state === "failed" &&
  item.failureCode === RETRYABLE_FAILED_WORK_ITEM_CODE

export const isRetryableNeedsHumanWorkItem = (
  item: Pick<WorkItemRecord, "state" | "stepRuns">,
): boolean => {
  if (item.state !== "needs_human") {
    return false
  }
  const latest = item.stepRuns.at(-1)
  return (
    latest?.status === "succeeded" &&
    (latest.step === "investigate_pr_status_checks" ||
      latest.step === "review" ||
      latest.reasonCode === STEP_RUN_REASON.missingSuccessfulChecks)
  )
}

/** Jobs card Failed tab: non-retryable terminal failures only. */
export const isJobsFailedWorkItem = (item: JobsListMembershipItem): boolean =>
  item.state === "failed" && !isRetryableFailedWorkItem(item)

/**
 * Jobs card Working tab: unfinished lifecycle work, retryable stoppages, and
 * Needs Human handoffs.
 */
export const isJobsWorkingWorkItem = (item: JobsListMembershipItem): boolean =>
  !isJobsCompletedWorkItemState(item.state) && !isJobsFailedWorkItem(item)

/** GraphQL / Jobs list partition: Working / Failed / Completed membership. */
export type WorkItemsListKind = "working" | "failed" | "completed"

const newestCreatedFirst = <T extends { readonly createdAt: Date }>(
  items: readonly T[],
): T[] =>
  items
    .slice()
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())

const newestStateReadyFirst = <T extends { readonly stateReadyAt: Date }>(
  items: readonly T[],
): T[] =>
  items
    .slice()
    .sort(
      (left, right) =>
        right.stateReadyAt.getTime() - left.stateReadyAt.getTime(),
    )

const applyLimit = <T>(
  items: readonly T[],
  limit: number | undefined,
): readonly T[] => (limit === undefined ? items : items.slice(0, limit))

/**
 * Filter Work Items for Jobs Working / Failed / Completed lists.
 * Failed is ordered by createdAt newest-first (recency for last-N windows).
 * Completed is Complete/Abandoned with stateReadyAt in the rolling previous
 * JOBS_COMPLETED_WINDOW_MS (from nowMs), ordered by stateReadyAt newest-first,
 * with no default item cap (optional limit still applies when provided).
 * Working preserves input order. Omitting listKind returns the input unchanged.
 */
export const filterWorkItemsByListKind = <
  T extends {
    readonly state: WorkItemState
    readonly failureCode?: string | null
    readonly createdAt: Date
    readonly stateReadyAt: Date
  },
>(
  workItems: readonly T[],
  listKind: WorkItemsListKind | undefined,
  limit?: number,
  nowMs: number = Date.now(),
): readonly T[] => {
  if (listKind === undefined) {
    return workItems
  }
  if (listKind === "working") {
    return applyLimit(workItems.filter(isJobsWorkingWorkItem), limit)
  }
  if (listKind === "failed") {
    return applyLimit(
      newestCreatedFirst(workItems.filter(isJobsFailedWorkItem)),
      limit,
    )
  }
  const windowStartMs = nowMs - JOBS_COMPLETED_WINDOW_MS
  return applyLimit(
    newestStateReadyFirst(
      workItems.filter(
        (item) =>
          isJobsCompletedWorkItemState(item.state) &&
          item.stateReadyAt.getTime() >= windowStartMs,
      ),
    ),
    limit,
  )
}

/** How a conditionally agent-using step completed its postcondition. */
export type LifecycleStepCompletion = "native" | "agent_fallback"

const AUTONOMOUS_MERGE_CHECK_REQUIREMENT =
  "Autonomous merge requires at least one successful external check. Configure or run a check, then Retry checks; otherwise review and merge the pull request manually."

/** Operator-facing reason when no checks were reported by the deadline. */
export const MISSING_SUCCESSFUL_CHECKS_REASON_NO_CHECKS = `No status checks were reported for this pull request by the check-start deadline. ${AUTONOMOUS_MERGE_CHECK_REQUIREMENT}`

/** Operator-facing reason when a required GitHub context stayed EXPECTED. */
export const MISSING_SUCCESSFUL_CHECKS_REASON_EXPECTED = `A required GitHub status context remained EXPECTED for this pull request by the check-start deadline. ${AUTONOMOUS_MERGE_CHECK_REQUIREMENT}`

/** Operator-facing reason when merge revalidation finds no successful checks. */
export const MISSING_SUCCESSFUL_CHECKS_REASON = `No successful status checks were reported for this pull request. ${AUTONOMOUS_MERGE_CHECK_REQUIREMENT}`

/** Default Autonomous Retry Budget: 3 accepted retries at the current step. */
export const DEFAULT_AUTONOMOUS_RETRY_LIMIT = 3

export type AutonomousRetryPolicy = {
  readonly maxRetries: number
}

export type RetryOptions = {
  readonly autonomous?: AutonomousRetryPolicy
}

export type WorkItemLifecycleConfig = {
  readonly maxDurations?: LifecycleMaxDurations
  /**
   * Working directory used when Implement With activates an otherwise
   * inactive shipped Agent Backend. Defaults to `process.cwd()`.
   */
  readonly inspectCwd?: string
}
