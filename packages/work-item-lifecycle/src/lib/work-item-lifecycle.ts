import { Context, Effect, Layer, Schema } from "effect"
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
  IssueBlockedError,
  IssueNotFoundError,
  IssueNotOpenError,
  NonTransactionalQueueError,
  ParentIssueError,
  StepRunNotFoundError,
  UnfinishedWorkItemExistsError,
  WorkItemLifecycleDatabaseError,
  WorkItemNotFoundError,
} from "./errors.js"
import { type LifecycleStepContext, LifecycleSteps } from "./lifecycle-steps.js"
import {
  type OperationalLifecycleStep,
  type StepRunId,
  type StepRunRecord,
  type StepRunStatus,
  WORK_ITEM_LIFECYCLE_QUEUE,
  type WorkItemId,
  type WorkItemRecord,
  type WorkItemState,
  WorkItemStepJob,
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

const toStepRunRecord = (row: StepRunRow): StepRunRecord => ({
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
})

const toWorkItemRecord = (
  row: WorkItemRow,
  stepRuns: readonly StepRunRecord[],
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

export type RunStepResult =
  | {
      readonly _tag: "processed"
      readonly workItem: WorkItemRecord
    }
  | {
      readonly _tag: "noop"
    }

export interface WorkItemLifecycleShape {
  readonly implementNow: (
    repositoryId: string,
    githubIssueNumber: number,
  ) => Effect.Effect<WorkItemRecord, ImplementNowError>
  readonly runStep: (
    stepRunId: string,
  ) => Effect.Effect<RunStepResult, RunStepError>
  readonly getWorkItem: (
    workItemId: string,
  ) => Effect.Effect<WorkItemRecord, GetWorkItemError>
  readonly listWorkItemsForIssue: (
    repositoryId: string,
    githubIssueNumber: number,
  ) => Effect.Effect<readonly WorkItemRecord[], ListWorkItemsError>
}

export class WorkItemLifecycle extends Context.Service<
  WorkItemLifecycle,
  WorkItemLifecycleShape
>()("@ready-for-agent/work-item-lifecycle/WorkItemLifecycle") {}

export const WorkItemLifecycleLive = Layer.effect(
  WorkItemLifecycle,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const db = yield* DbService
    const queue = yield* QueueService
    const steps = yield* LifecycleSteps

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
             ORDER BY created_at ASC, id ASC
             LIMIT 1`,
            [repositoryId, githubIssueNumber],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly { id: string }[]
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
             ORDER BY queued_at ASC, id ASC`,
            [...workItemIds],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly StepRunRow[]

        for (const row of rows) {
          const record = toStepRunRecord(row)
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

      const stepRunsByWorkItem = yield* loadStepRuns([row.id])
      return toWorkItemRecord(row, stepRunsByWorkItem.get(row.id) ?? [])
    })

    const listWorkItemsForIssue = Effect.fn(
      "WorkItemLifecycle.listWorkItemsForIssue",
    )(function* (repositoryId: string, githubIssueNumber: number) {
      const rows = (yield* sql
        .unsafe(
          `SELECT id, repository_id, github_issue_number, model, variant, state,
                  state_ready_at, worktree_path, session_id, failure_code,
                  failure_message, created_at, updated_at
           FROM work_item
           WHERE repository_id = ? AND github_issue_number = ?
           ORDER BY created_at ASC, id ASC`,
          [repositoryId, githubIssueNumber],
        )
        .pipe(Effect.mapError(toDatabaseError))) as readonly WorkItemRow[]

      const stepRunsByWorkItem = yield* loadStepRuns(rows.map((row) => row.id))
      return rows.map((row) =>
        toWorkItemRecord(row, stepRunsByWorkItem.get(row.id) ?? []),
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
    ): Effect.Effect<{
      readonly worktreePath?: string
      readonly sessionId?: string
    }> => {
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
        const now = Date.now()
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

      const startedAt = Date.now()
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
        .pipe(Effect.mapError(toDatabaseError))) as readonly StepRunRow[]

      const afterStart = startedRows[0]
      if (!afterStart) {
        return { _tag: "noop" as const }
      }

      const context: LifecycleStepContext = {
        workItemId: workItem.id as WorkItemId,
        repositoryId: workItem.repository_id,
        githubIssueNumber: workItem.github_issue_number,
        model: workItem.model,
        variant: workItem.variant,
        worktreePath: workItem.worktree_path,
        sessionId: workItem.session_id,
      }

      const output = yield* runHandler(stepRun.step, context)

      const revalidation = yield* revalidateIssue(
        workItem.repository_id,
        workItem.github_issue_number,
      )

      const completed = yield* completeSuccessfulStep({
        stepRun: afterStart,
        workItem,
        output,
        revalidation,
      })

      return { _tag: "processed" as const, workItem: completed }
    })

    const implementNow = Effect.fn("WorkItemLifecycle.implementNow")(function* (
      repositoryId: string,
      githubIssueNumber: number,
    ) {
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
      const now = Date.now()
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
    })

    return WorkItemLifecycle.of({
      implementNow,
      runStep,
      getWorkItem,
      listWorkItemsForIssue,
    })
  }),
)
