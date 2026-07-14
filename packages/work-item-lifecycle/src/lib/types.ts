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
  | "pre_commit"
  | "review"

export type WorkItemState =
  | OperationalLifecycleStep
  | "complete"
  | "failed"
  | "abandoned"

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
  readonly model: string
  readonly variant: string
  readonly state: WorkItemState
  readonly stateReadyAt: Date
  readonly worktreePath: string | null
  readonly sessionId: string | null
  readonly failureCode: string | null
  readonly failureMessage: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  /** Time the Work Item has spent in its current Lifecycle Step (from stateReadyAt). */
  readonly stateResidenceMs: number
  readonly stepRuns: readonly StepRunRecord[]
}

export const WORK_ITEM_LIFECYCLE_QUEUE = "jobs"

export const WorkItemStepJob = Schema.TaggedStruct("work-item-step", {
  stepRunId: StepRunId,
})
export type WorkItemStepJob = typeof WorkItemStepJob.Type

export const TERMINAL_WORK_ITEM_STATES = [
  "complete",
  "failed",
  "abandoned",
] as const satisfies readonly WorkItemState[]

export const isTerminalWorkItemState = (
  state: WorkItemState,
): state is (typeof TERMINAL_WORK_ITEM_STATES)[number] =>
  (TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(state)

export const STEP_RUN_REASON = {
  handlerFailed: "handler_failed",
  handlerDefect: "handler_defect",
  timeout: "timeout",
  interrupted: "interrupted",
  abandoned: "abandoned",
  reset: "reset",
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
  pre_commit: Duration.minutes(15),
  review: Duration.hours(1),
}

export type WorkItemLifecycleConfig = {
  readonly maxDurations?: LifecycleMaxDurations
}
