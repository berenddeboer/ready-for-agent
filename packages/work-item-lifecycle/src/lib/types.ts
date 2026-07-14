import { Schema } from "effect"
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
