import { Duration, Schema } from "effect"
import { ulid } from "ulidx"

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

export type OperationalLifecycleStep =
  | "create_worktree"
  | "install_dependencies"
  | "implement"
  | "assess_changes"
  | "pre_commit"
  | "review"
  | "commit"
  | "create_pr"
  | "watch_pr_status_checks"
  | "resolve_pr_merge_conflict"
  | "investigate_pr_status_checks"
  | "mark_pr_ready_for_review"
  | "decide_pr_merge"
  | "merge_pr"
  | "close_issue"
  | "local_cleanup"

export type WorkItemState =
  | OperationalLifecycleStep
  | "complete"
  | "failed"
  | "abandoned"
  | "needs_human"

export type StepRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"

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
  readonly githubIssueNumber: number
  readonly githubPullRequestNumber: number | null
  readonly model: string
  readonly variant: string
  readonly reviewModel: string
  readonly reviewVariant: string
  readonly state: WorkItemState
  readonly stateReadyAt: Date
  readonly paused: boolean
  /**
   * When set, the Work Item is Waiting for Worker Slot (FIFO by this timestamp).
   */
  readonly waitingSince: Date | null
  /** Whether this Work Item currently occupies a Worker Slot (Admitted). */
  readonly holdsWorkerSlot: boolean
  /** When set, advancement into this step auto-pauses (no Step Run enqueued). */
  readonly pauseBeforeStep: OperationalLifecycleStep | null
  readonly worktreePath: string | null
  /** Exact commit OID recorded by Create Worktree for Assess Changes. */
  readonly startingCommitOid: string | null
  /** Durable No-Change Outcome completion summary (Markdown). */
  readonly completionSummary: string | null
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

/** Operator-visible message while a running Step Run waits for an OpenCode session slot. */
export const WAITING_FOR_OPENCODE_SESSION_MESSAGE =
  "Waiting for an OpenCode session slot"

export const WORK_ITEM_LIFECYCLE_QUEUE = "jobs"

export const WorkItemStepJob = Schema.TaggedStruct("work-item-step", {
  stepRunId: StepRunId,
})
export type WorkItemStepJob = typeof WorkItemStepJob.Type

export const TERMINAL_WORK_ITEM_STATES = [
  "complete",
  "failed",
  "abandoned",
  "needs_human",
] as const satisfies readonly WorkItemState[]

export const isTerminalWorkItemState = (
  state: WorkItemState,
): state is (typeof TERMINAL_WORK_ITEM_STATES)[number] =>
  (TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(state)

/**
 * Jobs card Completed tab: successful finished outcomes only.
 * Terminal `failed` belongs on Failed. Needs Human stays on Working as active handoff.
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

/** Latest Step Run statuses that place a nonterminal Work Item on Failed. */
export const JOBS_FAILED_STEP_RUN_STATUSES = [
  "failed",
  "interrupted",
] as const satisfies readonly StepRunStatus[]

export type JobsFailedStepRunStatus =
  (typeof JOBS_FAILED_STEP_RUN_STATUSES)[number]

export const isJobsFailedStepRunStatus = (
  status: StepRunStatus,
): status is JobsFailedStepRunStatus =>
  (JOBS_FAILED_STEP_RUN_STATUSES as readonly string[]).includes(status)

type JobsListMembershipItem = {
  readonly state: WorkItemState
  readonly stepRuns: readonly { readonly status: StepRunStatus }[]
}

/**
 * Jobs card Failed tab: terminal `failed`, or nonterminal stopped on a
 * failed/interrupted latest Step Run (retriable).
 */
export const isJobsFailedWorkItem = (item: JobsListMembershipItem): boolean => {
  if (item.state === "failed") {
    return true
  }
  if (isTerminalWorkItemState(item.state)) {
    return false
  }
  const latest = item.stepRuns.at(-1)
  return latest !== undefined && isJobsFailedStepRunStatus(latest.status)
}

/**
 * Jobs card Working tab: unfinished lifecycle work plus Needs Human handoffs,
 * excluding Work Items currently stopped on a failed/interrupted Step Run.
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

const applyLimit = <T>(
  items: readonly T[],
  limit: number | undefined,
): readonly T[] => (limit === undefined ? items : items.slice(0, limit))

/**
 * Filter Work Items for Jobs Working / Failed / Completed lists.
 * Failed and Completed are ordered by createdAt newest-first (recency for last-N windows).
 * Working preserves input order. Omitting listKind returns the input unchanged.
 */
export const filterWorkItemsByListKind = <
  T extends {
    readonly state: WorkItemState
    readonly createdAt: Date
    readonly stepRuns: readonly { readonly status: StepRunStatus }[]
  },
>(
  workItems: readonly T[],
  listKind: WorkItemsListKind | undefined,
  limit?: number,
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
  return applyLimit(
    newestCreatedFirst(
      workItems.filter((item) => isJobsCompletedWorkItemState(item.state)),
    ),
    limit,
  )
}

export const STEP_RUN_REASON = {
  handlerFailed: "handler_failed",
  handlerDefect: "handler_defect",
  timeout: "timeout",
  interrupted: "interrupted",
  /** Prior harness/job-worker process ended while the Step Run was still Running. */
  workerRestarted: "worker_restarted",
  abandoned: "abandoned",
  reset: "reset",
  paused: "paused",
  /** Mid-run: Step Run is Running but blocked on maxConcurrentOpencodeSessions. */
  waitingForOpencodeSession: "waiting_for_opencode_session",
} as const

export type StepRunReasonCode =
  (typeof STEP_RUN_REASON)[keyof typeof STEP_RUN_REASON]

export type LifecycleMaxDurations = {
  readonly [Step in OperationalLifecycleStep]: Duration.Duration
}

/** Default maximum Effect durations per Lifecycle Step (also used as visibility leases). */
export const DEFAULT_LIFECYCLE_MAX_DURATIONS: LifecycleMaxDurations = {
  create_worktree: Duration.minutes(5),
  install_dependencies: Duration.minutes(15),
  implement: Duration.hours(2),
  assess_changes: Duration.hours(1),
  pre_commit: Duration.hours(2),
  review: Duration.hours(1),
  commit: Duration.minutes(5),
  create_pr: Duration.minutes(10),
  watch_pr_status_checks: Duration.minutes(5),
  resolve_pr_merge_conflict: Duration.hours(2),
  investigate_pr_status_checks: Duration.hours(2),
  mark_pr_ready_for_review: Duration.minutes(5),
  decide_pr_merge: Duration.minutes(15),
  merge_pr: Duration.minutes(5),
  close_issue: Duration.minutes(5),
  local_cleanup: Duration.minutes(5),
}

export type WorkItemLifecycleConfig = {
  readonly maxDurations?: LifecycleMaxDurations
}
