import { Schema } from "effect"
import { ulid } from "ulidx"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  type LifecycleMaxDurations,
  OperationalLifecycleStep,
  TERMINAL_WORK_ITEM_STATES,
  TerminalWorkItemState,
  WorkItemState,
} from "@ready-for-agent/lifecycle-model"
import {
  JOBS_COMPLETED_WINDOW_HOURS,
  JOBS_COMPLETED_WINDOW_MS,
} from "./jobs-completed-window.js"

export {
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

export const StepRunStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
])
export type StepRunStatus = typeof StepRunStatus.Type

/**
 * Durable Work Item merge policy.
 * `ordinary` follows Repository Auto-merge and Decide PR Merge.
 * `always` skips Decide PR Merge after pre-merge lifecycle settles.
 */
export const MergeMode = Schema.Literals(["ordinary", "always"])
export type MergeMode = typeof MergeMode.Type

export interface StepRunRecord {
  readonly id: StepRunId
  readonly workItemId: WorkItemId
  readonly step: OperationalLifecycleStep
  readonly status: StepRunStatus
  readonly queueJobId: string | null
  readonly queuedAt: Date
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  readonly reasonCode: string | null
  readonly reasonMessage: string | null
  /** Time from queued until start (or finish/now if never started). */
  readonly queueWaitMs: number
  /** Time from start until finish/now; null when execution never began. */
  readonly executionDurationMs: number | null
}

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
   * Canonical agent-authored publication title for Commit subject and PR title.
   * Null until Commit generates or seeds it.
   */
  readonly publicationTitle: string | null
  /**
   * Canonical agent-authored publication body for Commit body and PR body.
   * Null until Commit generates or seeds it.
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
    (latest.step === "investigate_pr_status_checks" || latest.step === "review")
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

export const STEP_RUN_REASON = {
  handlerFailed: "handler_failed",
  handlerDefect: "handler_defect",
  prStatusChecksUnresolved: "pr_status_checks_unresolved",
  timeout: "timeout",
  interrupted: "interrupted",
  /** Prior harness/job-worker process ended while the Step Run was still Running. */
  workerRestarted: "worker_restarted",
  abandoned: "abandoned",
  reset: "reset",
  paused: "paused",
  /** Mid-run: Step Run is Running but blocked on maxConcurrentAgentTurns. */
  waitingForAgentTurn: "waiting_for_agent_turn",
  /** Agent-dependent step blocked because Active Agent Backend is unavailable. */
  agentBackendUnavailable: "agent_backend_unavailable",
  /** Agent-dependent step blocked because no build Agent Model is configured. */
  buildModelNotConfigured: "build_model_not_configured",
  /** Mid-run: Review is running the reviewing (/review) OpenCode pass. */
  reviewReviewing: "review_reviewing",
  /** Mid-run: Review is applying findings with the build model. */
  reviewApplyingFindings: "review_applying_findings",
  /** Mid-run: Review is re-running Pre-Commit after FIXED before re-review. */
  reviewPreCommit: "review_pre_commit",
  /** Mid-run: Review is assessing whether low-severity remediation needs rerun. */
  reviewAssessingRerun: "review_assessing_rerun",
  /** Successful Review that deferred findings and advanced to Commit. */
  reviewDeferred: "review_deferred",
  /** Successful Review that cleared low/medium findings without changes. */
  reviewCleared: "review_cleared",
  /** Successful Review that accepted low-severity remediation without full rerun. */
  reviewAccepted: "review_accepted",
  /** Successful Merge PR run that returned to Watch for fresh validation. */
  mergeRevalidation: "merge_revalidation",
  /**
   * Green-only Status Check Handoff completed without an Agent Turn because
   * harness-owned GitHub observation found no positive automated-review evidence.
   */
  greenNoReviewEvidence: "green-no-review-evidence",
  /**
   * Confirmed Work Item PR merge outcome. Used when:
   * - a Step Run is interrupted/cancelled because the PR merged before it finished
   * - a successful Step Run stops at Issue revalidation because the Issue is
   *   closed/missing and the owned PR is already merged (advance to local cleanup)
   */
  prMerged: "pr_merged",
  /**
   * Successful Step Run that stopped because Issue revalidation found the
   * Issue closed/missing while a Work Item PR is still open (or PR status
   * was indeterminate). Work Item is paused for operator Start after reopen.
   */
  issueClosedWhilePrOpen: "issue_closed_while_pr_open",
  /**
   * Successful Step Run that stopped because Issue revalidation found the
   * Issue closed/missing and the Work Item PR was closed without merge.
   * Work Item is paused for operator decision (Start / Abandon / Reset).
   */
  issueClosedPrClosedUnmerged: "issue_closed_pr_closed_unmerged",
  /**
   * Conditionally agent-using step completed via harness-owned native path
   * (no Agent Turn).
   */
  native: "native",
  /**
   * Conditionally agent-using step completed via one repair Agent Turn after
   * the native path did not establish the postcondition.
   */
  agentFallback: "agent_fallback",
  /**
   * Mid-run: Commit is generating shared publication copy via an Agent Turn
   * before the native git commit attempt.
   */
  copyGeneration: "copy_generation",
} as const

export type StepRunReasonCode =
  (typeof STEP_RUN_REASON)[keyof typeof STEP_RUN_REASON]

export type WorkItemLifecycleConfig = {
  readonly maxDurations?: LifecycleMaxDurations
}
