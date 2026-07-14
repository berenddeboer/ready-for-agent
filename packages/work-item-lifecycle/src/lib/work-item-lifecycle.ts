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
  Result,
  Schema,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  type DatabaseError,
  DbService,
  type RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import {
  type AcknowledgeError,
  EnqueueError,
  InvalidQueueNameError,
  type JobNotFoundError,
  QueueService,
} from "@ready-for-agent/queue-service"
import {
  ActiveStepRunExistsError,
  IssueBlockedError,
  IssueNotFoundError,
  IssueNotOpenError,
  NonTransactionalQueueError,
  ParentIssueError,
  ResetCleanupError,
  RetryNotEligibleError,
  StepRunNotFoundError,
  UnfinishedWorkItemExistsError,
  WorkItemHasRunningStepError,
  WorkItemLifecycleDatabaseError,
  WorkItemNotFoundError,
  WorkItemTerminalError,
} from "./errors.js"
import { type LifecycleStepContext, LifecycleSteps } from "./lifecycle-steps.js"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  type LifecycleMaxDurations,
  type OperationalLifecycleStep,
  STEP_RUN_REASON,
  type StepRunId,
  type StepRunRecord,
  type StepRunStatus,
  WORK_ITEM_LIFECYCLE_QUEUE,
  type WorkItemId,
  type WorkItemLifecycleConfig,
  type WorkItemRecord,
  type WorkItemState,
  WorkItemStepJob,
  isTerminalWorkItemState,
  makeStepRunId,
  makeWorkItemId,
} from "./types.js"

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
      (message.includes("work_item.repository_id") &&
        message.includes("work_item.github_issue_number")))
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

const conciseMessage = (value: unknown, fallback: string): string => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim().slice(0, 500)
  }
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message.trim().slice(0, 500)
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string" &&
    (value as { message: string }).message.trim().length > 0
  ) {
    return (value as { message: string }).message.trim().slice(0, 500)
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return fallback
}

const classifyHandlerFailure = (
  cause: Cause.Cause<unknown>,
): {
  readonly reasonCode: string
  readonly reasonMessage: string
} => {
  const errorOption = Cause.findErrorOption(cause)
  if (Option.isSome(errorOption)) {
    const error = errorOption.value
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: string })._tag === "TimeoutError"
    ) {
      return {
        reasonCode: STEP_RUN_REASON.timeout,
        reasonMessage:
          "Lifecycle Step exceeded its configured maximum duration",
      }
    }
    return {
      reasonCode: STEP_RUN_REASON.handlerFailed,
      reasonMessage: conciseMessage(error, "Lifecycle Step handler failed"),
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
  readonly github_issue_number: number
  readonly model: string
  readonly variant: string
  readonly state: WorkItemState
  readonly state_ready_at: number
  readonly worktree_path: string | null
  readonly session_id: string | null
  readonly failure_code: string | null
  readonly failure_message: string | null
  readonly created_at: number
  readonly updated_at: number
}

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
}

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

const toStepRunRecord = (row: StepRunRow, nowMs: number): StepRunRecord => ({
  id: row.id as StepRunId,
  workItemId: row.work_item_id as WorkItemId,
  step: row.step,
  status: row.status,
  queueJobId: row.queue_job_id,
  queuedAt: new Date(row.queued_at),
  startedAt: row.started_at === null ? null : new Date(row.started_at),
  finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
  reasonCode: row.reason_code,
  reasonMessage: row.reason_message,
  queueWaitMs: deriveQueueWaitMs(row, nowMs),
  executionDurationMs: deriveExecutionDurationMs(row, nowMs),
})

const toWorkItemRecord = (
  row: WorkItemRow,
  stepRuns: readonly StepRunRecord[],
  nowMs: number,
): WorkItemRecord => ({
  id: row.id as WorkItemId,
  repositoryId: row.repository_id,
  githubIssueNumber: row.github_issue_number,
  model: row.model,
  variant: row.variant,
  state: row.state,
  stateReadyAt: new Date(row.state_ready_at),
  worktreePath: row.worktree_path,
  sessionId: row.session_id,
  failureCode: row.failure_code,
  failureMessage: row.failure_message,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  stateResidenceMs: Math.max(0, nowMs - row.state_ready_at),
  stepRuns,
})

const nextOperationalStep = (
  step: OperationalLifecycleStep,
): OperationalLifecycleStep | "complete" => {
  switch (step) {
    case "create_worktree":
      return "install_dependencies"
    case "install_dependencies":
      return "implement"
    case "implement":
      return "review"
    case "review":
      return "complete"
  }
}

export type ImplementNowError =
  | IssueNotFoundError
  | IssueNotOpenError
  | ParentIssueError
  | IssueBlockedError
  | UnfinishedWorkItemExistsError
  | WorkItemLifecycleDatabaseError
  | RepositoryNotFoundError
  | DatabaseError
  | EnqueueError
  | InvalidQueueNameError

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
  | WorkItemLifecycleDatabaseError
  | AcknowledgeError
  | JobNotFoundError

export type ResetError =
  | WorkItemNotFoundError
  | ResetCleanupError
  | WorkItemLifecycleDatabaseError
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

export interface WorkItemLifecycleShape {
  readonly maxDurations: LifecycleMaxDurations
  readonly implementNow: (
    repositoryId: string,
    githubIssueNumber: number,
  ) => Effect.Effect<WorkItemRecord, ImplementNowError>
  readonly runStep: (
    stepRunId: string,
  ) => Effect.Effect<RunStepResult, RunStepError>
  readonly retry: (
    workItemId: string,
  ) => Effect.Effect<WorkItemRecord, RetryError>
  readonly abandon: (
    workItemId: string,
  ) => Effect.Effect<WorkItemRecord, AbandonError>
  readonly reset: (workItemId: string) => Effect.Effect<WorkItemId, ResetError>
  readonly getWorkItem: (
    workItemId: string,
  ) => Effect.Effect<WorkItemRecord, GetWorkItemError>
  readonly listWorkItemsForIssue: (
    repositoryId: string,
    githubIssueNumber: number,
  ) => Effect.Effect<readonly WorkItemRecord[], ListWorkItemsError>
  readonly listWorkItemsForRepository: (
    repositoryId: string,
  ) => Effect.Effect<readonly WorkItemRecord[], ListWorkItemsError>
}

export class WorkItemLifecycle extends Context.Service<
  WorkItemLifecycle,
  WorkItemLifecycleShape
>()("@ready-for-agent/work-item-lifecycle/WorkItemLifecycle") {}

export const makeWorkItemLifecycleLive = (
  config: WorkItemLifecycleConfig = {},
): Layer.Layer<
  WorkItemLifecycle,
  NonTransactionalQueueError,
  SqlClient.SqlClient | DbService | QueueService | LifecycleSteps
> =>
  Layer.effect(
    WorkItemLifecycle,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const db = yield* DbService
      const queue = yield* QueueService
      const steps = yield* LifecycleSteps
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

      if (!queue.queueInTransaction) {
        return yield* new NonTransactionalQueueError({
          message:
            "Work Item Lifecycle requires a QueueService that participates in database transactions",
        })
      }

      const findUnfinishedWorkItemId = (
        repositoryId: string,
        githubIssueNumber: number,
      ): Effect.Effect<string | null, WorkItemLifecycleDatabaseError> =>
        Effect.gen(function* () {
          const rows = (yield* sql
            .unsafe(
              `SELECT id FROM work_item
             WHERE repository_id = ?
               AND github_issue_number = ?
               AND state NOT IN ('complete', 'failed', 'abandoned')
             ORDER BY created_at ASC, rowid ASC
             LIMIT 1`,
              [repositoryId, githubIssueNumber],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            id: string
          }[]
          return rows[0]?.id ?? null
        })

      const unfinishedWorkItemExistsError = (
        repositoryId: string,
        githubIssueNumber: number,
        knownWorkItemId?: string,
      ): Effect.Effect<
        never,
        UnfinishedWorkItemExistsError | WorkItemLifecycleDatabaseError
      > =>
        Effect.gen(function* () {
          const workItemId =
            knownWorkItemId ??
            (yield* findUnfinishedWorkItemId(repositoryId, githubIssueNumber))
          return yield* new UnfinishedWorkItemExistsError({
            repositoryId,
            githubIssueNumber,
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
              `SELECT id, work_item_id, step, status, queue_job_id, queued_at,
                    started_at, finished_at, reason_code, reason_message
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
            `SELECT id, repository_id, github_issue_number, model, variant, state,
                  state_ready_at, worktree_path, session_id, failure_code,
                  failure_message, created_at, updated_at
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
      )(function* (repositoryId: string, githubIssueNumber: number) {
        const nowMs = yield* Clock.currentTimeMillis
        const rows = (yield* sql
          .unsafe(
            `SELECT id, repository_id, github_issue_number, model, variant, state,
                  state_ready_at, worktree_path, session_id, failure_code,
                  failure_message, created_at, updated_at
           FROM work_item
           WHERE repository_id = ? AND github_issue_number = ?
           ORDER BY created_at ASC, rowid ASC`,
            [repositoryId, githubIssueNumber],
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
            `SELECT id, repository_id, github_issue_number, model, variant, state,
                  state_ready_at, worktree_path, session_id, failure_code,
                  failure_message, created_at, updated_at
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

      const loadStepRunRow = (
        stepRunId: string,
      ): Effect.Effect<StepRunRow | null, WorkItemLifecycleDatabaseError> =>
        Effect.gen(function* () {
          const rows = (yield* sql
            .unsafe(
              `SELECT id, work_item_id, step, status, queue_job_id, queued_at,
                    started_at, finished_at, reason_code, reason_message
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
              `SELECT id, repository_id, github_issue_number, model, variant, state,
                    state_ready_at, worktree_path, session_id, failure_code,
                    failure_message, created_at, updated_at
             FROM work_item
             WHERE id = ?
             LIMIT 1`,
              [workItemId],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly WorkItemRow[]
          return rows[0] ?? null
        })

      const revalidateIssue = (
        repositoryId: string,
        githubIssueNumber: number,
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
            (candidate) => candidate.githubIssueNumber === githubIssueNumber,
          )

          if (!issue) {
            return {
              ok: false as const,
              failureCode: "issue_not_found",
              failureMessage: `Issue #${githubIssueNumber} is no longer present in the Issue store`,
            }
          }

          if (issue.state !== "OPEN") {
            return {
              ok: false as const,
              failureCode: "issue_not_open",
              failureMessage: `Issue #${githubIssueNumber} is ${issue.state}, not OPEN`,
            }
          }

          if (issue.hasChildren) {
            return {
              ok: false as const,
              failureCode: "issue_is_parent",
              failureMessage: `Issue #${githubIssueNumber} has children and is no longer a Leaf Issue`,
            }
          }

          if (issue.blockedBy.length > 0) {
            return {
              ok: false as const,
              failureCode: "issue_blocked",
              failureMessage: `Issue #${githubIssueNumber} is blocked by ${issue.blockedBy.length} Issue(s)`,
            }
          }

          return { ok: true as const }
        })

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

      const runHandler = (
        step: OperationalLifecycleStep,
        context: LifecycleStepContext,
      ): Effect.Effect<
        {
          readonly worktreePath?: string
          readonly sessionId?: string
        },
        unknown
      > => {
        switch (step) {
          case "create_worktree":
            return steps
              .createWorktree(context)
              .pipe(Effect.map((worktreePath) => ({ worktreePath })))
          case "install_dependencies":
            return steps.installDependencies(context).pipe(Effect.as({}))
          case "implement":
            return steps
              .implement(context)
              .pipe(Effect.map((sessionId) => ({ sessionId })))
          case "review":
            return steps.review(context).pipe(Effect.as({}))
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

      const completeSuccessfulStep = (input: {
        readonly stepRun: StepRunRow
        readonly workItem: WorkItemRow
        readonly output: {
          readonly worktreePath?: string
          readonly sessionId?: string
        }
        readonly revalidation:
          | { readonly ok: true }
          | {
              readonly ok: false
              readonly failureCode: string
              readonly failureMessage: string
            }
      }): Effect.Effect<WorkItemRecord, RunStepError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const { stepRun, workItem, output, revalidation } = input
          const nextStep = nextOperationalStep(stepRun.step)
          const worktreePath = output.worktreePath ?? workItem.worktree_path
          const sessionId = output.sessionId ?? workItem.session_id

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(
                  `UPDATE step_run
                 SET status = 'succeeded', finished_at = ?, updated_at = ?
                 WHERE id = ? AND status = 'running'`,
                  [now, now, stepRun.id],
                )

                if (!revalidation.ok) {
                  yield* sql.unsafe(
                    `UPDATE work_item
                   SET state = 'failed',
                       state_ready_at = ?,
                       failure_code = ?,
                       failure_message = ?,
                       worktree_path = ?,
                       session_id = ?,
                       updated_at = ?
                   WHERE id = ?`,
                    [
                      now,
                      revalidation.failureCode,
                      revalidation.failureMessage,
                      worktreePath,
                      sessionId,
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
                       session_id = ?,
                       updated_at = ?
                   WHERE id = ?`,
                    [now, worktreePath, sessionId, now, workItem.id],
                  )
                } else {
                  const nextStepRunId = makeStepRunId()

                  yield* sql.unsafe(
                    `UPDATE work_item
                   SET state = ?,
                       state_ready_at = ?,
                       worktree_path = ?,
                       session_id = ?,
                       updated_at = ?
                   WHERE id = ?`,
                    [nextStep, now, worktreePath, sessionId, now, workItem.id],
                  )

                  yield* sql.unsafe(
                    `INSERT INTO step_run (
                     id, work_item_id, step, status, queue_job_id, queued_at,
                     started_at, finished_at, reason_code, reason_message,
                     created_at, updated_at
                   ) VALUES (?, ?, ?, 'queued', NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
                    [nextStepRunId, workItem.id, nextStep, now, now, now],
                  )

                  const payload = yield* encodeStepJob(nextStepRunId)
                  const jobId = yield* queue.enqueue(
                    WORK_ITEM_LIFECYCLE_QUEUE,
                    payload,
                    { retryLimit: 1 },
                  )

                  yield* sql.unsafe(
                    `UPDATE step_run
                   SET queue_job_id = ?, updated_at = ?
                   WHERE id = ?`,
                    [jobId, now, nextStepRunId],
                  )
                }

                if (stepRun.queue_job_id !== null) {
                  yield* queue.acknowledge(stepRun.queue_job_id)
                }
              }),
            )
            .pipe(Effect.catch(catchTransactionError))

          return yield* getWorkItem(workItem.id).pipe(
            Effect.catchTag(
              "WorkItemNotFoundError",
              (error) =>
                new WorkItemLifecycleDatabaseError({
                  message: `Work Item missing after step completion: ${error.workItemId}`,
                  cause: error,
                }),
            ),
          )
        })

      const completeFailedStep = (input: {
        readonly stepRun: StepRunRow
        readonly workItem: WorkItemRow
        readonly reasonCode: string
        readonly reasonMessage: string
        readonly cause: Cause.Cause<unknown>
      }): Effect.Effect<WorkItemRecord, RunStepError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const { stepRun, workItem, reasonCode, reasonMessage, cause } = input

          yield* Effect.logError("Lifecycle Step handler failed", {
            workItemId: workItem.id,
            stepRunId: stepRun.id,
            step: stepRun.step,
            reasonCode,
            reasonMessage,
            cause: Cause.pretty(cause),
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

                if (stepRun.queue_job_id !== null) {
                  yield* queue.fail(stepRun.queue_job_id, {
                    retryable: false,
                  })
                }
              }),
            )
            .pipe(Effect.catch(catchTransactionError))

          return yield* getWorkItem(workItem.id).pipe(
            Effect.catchTag(
              "WorkItemNotFoundError",
              (error) =>
                new WorkItemLifecycleDatabaseError({
                  message: `Work Item missing after step failure: ${error.workItemId}`,
                  cause: error,
                }),
            ),
          )
        })

      const completeInterruptedStep = (input: {
        readonly stepRun: StepRunRow
        readonly reasonMessage: string
        readonly cause?: Cause.Cause<unknown>
      }): Effect.Effect<void, RunStepError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const { stepRun, reasonMessage, cause } = input

          if (cause) {
            yield* Effect.logWarning("Lifecycle Step interrupted", {
              workItemId: stepRun.work_item_id,
              stepRunId: stepRun.id,
              step: stepRun.step,
              reasonMessage,
              cause: Cause.pretty(cause),
            })
          }

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
              activeStepExecutions.has(stepRunId)
            ) {
              return false
            }
            activeStepExecutions.set(stepRunId, controller)
            return true
          }),
          (registered) => {
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
                  AND work_item.state NOT IN ('complete', 'failed', 'abandoned')
              )
              AND NOT EXISTS (
                SELECT 1 FROM step_run AS other
                 WHERE other.work_item_id = step_run.work_item_id
                   AND other.status = 'running'
                   AND other.id != step_run.id
               )
             RETURNING id, work_item_id, step, status, queue_job_id, queued_at,
                       started_at, finished_at, reason_code, reason_message`,
                  [startedAt, startedAt, stepRunId, stepRun.step],
                )
                .pipe(
                  Effect.mapError(toDatabaseError),
                )) as readonly StepRunRow[]

              const afterStart = startedRows[0]
              if (!afterStart) {
                const current = yield* loadStepRunRow(stepRunId)
                if (current?.status === "running") {
                  const maxDurationMs = Duration.toMillis(
                    maxDurations[current.step],
                  )
                  const startedMs = current.started_at ?? 0
                  const nowMs = yield* Clock.currentTimeMillis
                  const leaseExpired = nowMs - startedMs >= maxDurationMs
                  if (leaseExpired) {
                    yield* completeInterruptedStep({
                      stepRun: current,
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

              const maxDuration = maxDurations[stepRun.step]
              const context: LifecycleStepContext = {
                workItemId: workItem.id as WorkItemId,
                repositoryId: workItem.repository_id,
                githubIssueNumber: workItem.github_issue_number,
                model: workItem.model,
                variant: workItem.variant,
                worktreePath: workItem.worktree_path,
                sessionId: workItem.session_id,
                maxDuration,
              }

              const result = yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const handlerExit = yield* Effect.exit(
                    restore(
                      Effect.raceFirst(
                        Effect.suspend(() =>
                          runHandler(stepRun.step, context),
                        ).pipe(Effect.timeout(maxDuration)),
                        Deferred.await(cancel).pipe(
                          Effect.andThen(Effect.interrupt),
                        ),
                      ),
                    ),
                  )

                  if (Exit.isFailure(handlerExit)) {
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

                    const failed = yield* completeFailedStep({
                      stepRun: afterStart,
                      workItem,
                      reasonCode: classification.reasonCode,
                      reasonMessage: classification.reasonMessage,
                      cause: handlerExit.cause,
                    })
                    return { _tag: "processed" as const, workItem: failed }
                  }

                  const revalidation = yield* revalidateIssue(
                    workItem.repository_id,
                    workItem.github_issue_number,
                  )

                  const completed = yield* completeSuccessfulStep({
                    stepRun: afterStart,
                    workItem,
                    output: handlerExit.value,
                    revalidation,
                  })

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

      const abandon = Effect.fn("WorkItemLifecycle.abandon")(function* (
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

        const now = yield* Clock.currentTimeMillis

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const abandonedRows = (yield* sql.unsafe(
                `UPDATE work_item
                  SET state = 'abandoned',
                      state_ready_at = ?,
                      updated_at = ?
                  WHERE id = ?
                    AND state NOT IN ('complete', 'failed', 'abandoned')
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
                if (isTerminalWorkItemState(current.state)) {
                  return yield* new WorkItemTerminalError({
                    workItemId,
                    state: current.state,
                  })
                }

                const runningRows = (yield* sql.unsafe(
                  `SELECT id FROM step_run
                   WHERE work_item_id = ? AND status = 'running'
                   ORDER BY queued_at DESC, id DESC
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
            }),
          )
          .pipe(
            Effect.catch((error): Effect.Effect<never, AbandonError> => {
              if (
                error instanceof WorkItemNotFoundError ||
                error instanceof WorkItemTerminalError ||
                error instanceof WorkItemHasRunningStepError
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

        return yield* getWorkItem(workItemId).pipe(
          Effect.catchTag(
            "WorkItemNotFoundError",
            (error) =>
              new WorkItemLifecycleDatabaseError({
                message: `Work Item missing after abandon: ${error.workItemId}`,
                cause: error,
              }),
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

          const cleanupContext: LifecycleStepContext = {
            workItemId: currentWorkItem.id as WorkItemId,
            repositoryId: currentWorkItem.repository_id,
            githubIssueNumber: currentWorkItem.github_issue_number,
            model: currentWorkItem.model,
            variant: currentWorkItem.variant,
            worktreePath: currentWorkItem.worktree_path,
            sessionId: currentWorkItem.session_id,
          }

          yield* steps.removeWorktree(cleanupContext).pipe(
            Effect.mapError(
              (cause) =>
                new ResetCleanupError({
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

        if (isTerminalWorkItemState(workItem.state)) {
          return yield* new WorkItemTerminalError({
            workItemId,
            state: workItem.state,
          })
        }

        const pendingStep = workItem.state as OperationalLifecycleStep

        const activeRows = (yield* sql
          .unsafe(
            `SELECT id, work_item_id, step, status, queue_job_id, queued_at,
                  started_at, finished_at, reason_code, reason_message
           FROM step_run
           WHERE work_item_id = ?
             AND status IN ('queued', 'running')
           ORDER BY queued_at DESC, id DESC
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

        const latestPendingRows = (yield* sql
          .unsafe(
            `SELECT id, work_item_id, step, status, queue_job_id, queued_at,
                  started_at, finished_at, reason_code, reason_message
           FROM step_run
           WHERE work_item_id = ?
             AND step = ?
           ORDER BY queued_at DESC, id DESC
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

        const now = yield* Clock.currentTimeMillis
        const nextStepRunId = makeStepRunId()

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                `INSERT INTO step_run (
                 id, work_item_id, step, status, queue_job_id, queued_at,
                 started_at, finished_at, reason_code, reason_message,
                 created_at, updated_at
               ) VALUES (?, ?, ?, 'queued', NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
                [nextStepRunId, workItemId, pendingStep, now, now, now],
              )

              const payload = yield* encodeStepJob(nextStepRunId)
              const jobId = yield* queue.enqueue(
                WORK_ITEM_LIFECYCLE_QUEUE,
                payload,
                { retryLimit: 1 },
              )

              yield* sql.unsafe(
                `UPDATE step_run
               SET queue_job_id = ?, updated_at = ?
               WHERE id = ?`,
                [jobId, now, nextStepRunId],
              )

              yield* sql.unsafe(
                `UPDATE work_item
               SET updated_at = ?
               WHERE id = ?`,
                [now, workItemId],
              )
            }),
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
                       ORDER BY queued_at DESC, id DESC
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

        return yield* getWorkItem(workItemId).pipe(
          Effect.catchTag(
            "WorkItemNotFoundError",
            (error) =>
              new WorkItemLifecycleDatabaseError({
                message: `Work Item missing after retry: ${error.workItemId}`,
                cause: error,
              }),
          ),
        )
      })

      const implementNow = Effect.fn("WorkItemLifecycle.implementNow")(
        function* (repositoryId: string, githubIssueNumber: number) {
          const issues = yield* db.listIssues(repositoryId)
          const issue = issues.find(
            (candidate) => candidate.githubIssueNumber === githubIssueNumber,
          )

          if (!issue) {
            return yield* new IssueNotFoundError({
              repositoryId,
              githubIssueNumber,
            })
          }

          if (issue.state !== "OPEN") {
            return yield* new IssueNotOpenError({
              repositoryId,
              githubIssueNumber,
              state: issue.state,
            })
          }

          if (issue.hasChildren) {
            return yield* new ParentIssueError({
              repositoryId,
              githubIssueNumber,
            })
          }

          if (issue.blockedBy.length > 0) {
            return yield* new IssueBlockedError({
              repositoryId,
              githubIssueNumber,
              blockerCount: issue.blockedBy.length,
            })
          }

          const existing = yield* listWorkItemsForIssue(
            repositoryId,
            githubIssueNumber,
          )
          const unfinished = existing.find(
            (item) =>
              item.state !== "complete" &&
              item.state !== "failed" &&
              item.state !== "abandoned",
          )
          if (unfinished) {
            return yield* unfinishedWorkItemExistsError(
              repositoryId,
              githubIssueNumber,
              unfinished.id,
            )
          }

          const config = yield* db.getConfig
          const workItemId = makeWorkItemId()
          const stepRunId = makeStepRunId()
          const now = yield* Clock.currentTimeMillis
          const step: OperationalLifecycleStep = "create_worktree"

          const createdId = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(
                  `INSERT INTO work_item (
                 id, repository_id, github_issue_number, model, variant, state,
                 state_ready_at, worktree_path, session_id, failure_code,
                 failure_message, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
                  [
                    workItemId,
                    repositoryId,
                    githubIssueNumber,
                    config.defaultModel,
                    config.defaultVariant,
                    step,
                    now,
                    now,
                    now,
                  ],
                )

                yield* sql.unsafe(
                  `INSERT INTO step_run (
                 id, work_item_id, step, status, queue_job_id, queued_at,
                 started_at, finished_at, reason_code, reason_message,
                 created_at, updated_at
               ) VALUES (?, ?, ?, 'queued', NULL, ?, NULL, NULL, NULL, NULL, ?, ?)`,
                  [stepRunId, workItemId, step, now, now, now],
                )

                const payload = yield* encodeStepJob(stepRunId)

                const jobId = yield* queue.enqueue(
                  WORK_ITEM_LIFECYCLE_QUEUE,
                  payload,
                  { retryLimit: 1 },
                )

                yield* sql.unsafe(
                  `UPDATE step_run
               SET queue_job_id = ?, updated_at = ?
               WHERE id = ?`,
                  [jobId, now, stepRunId],
                )

                return workItemId
              }),
            )
            .pipe(
              Effect.catch((error): Effect.Effect<never, ImplementNowError> => {
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
                      githubIssueNumber,
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

          return yield* getWorkItem(createdId).pipe(
            Effect.catchTag(
              "WorkItemNotFoundError",
              (error) =>
                new WorkItemLifecycleDatabaseError({
                  message: `Work Item missing after create: ${error.workItemId}`,
                  cause: error,
                }),
            ),
          )
        },
      )

      return WorkItemLifecycle.of({
        maxDurations,
        implementNow,
        runStep,
        retry,
        abandon,
        reset,
        getWorkItem,
        listWorkItemsForIssue,
        listWorkItemsForRepository,
      })
    }),
  )

export const WorkItemLifecycleLive = makeWorkItemLifecycleLive()
