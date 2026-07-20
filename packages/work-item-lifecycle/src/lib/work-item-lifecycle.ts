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
  type DatabaseError,
  DbService,
  type RepositoryNotFoundError,
} from "@ready-for-agent/db-service"
import {
  formatUserFacingError,
  sanitizeUserFacingText,
} from "@ready-for-agent/github-service"
import {
  type AcknowledgeError,
  EnqueueError,
  InvalidQueueNameError,
  type JobNotFoundError,
  QueueService,
} from "@ready-for-agent/queue-service"
import { CloseIssueEligibilityError } from "./close-issue-errors.js"
import {
  AbandonCleanupError,
  ActiveStepRunExistsError,
  BuildModelNotConfiguredError,
  IssueBlockedError,
  IssueNotFoundError,
  IssueNotOpenError,
  NeedsHumanHandoffNotEligibleError,
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
import {
  type LifecycleStepContext,
  LifecycleSteps,
  type RunHandlerError,
} from "./lifecycle-steps.js"
import { CurrentStepRun } from "./opencode-session-limiter.js"
import { PrStatusChecksUnresolvedError } from "./pr-status-checks.js"
import {
  PreCommitHookFailedError,
  PreCommitStageError,
} from "./pre-commit-errors.js"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  type LifecycleMaxDurations,
  type OperationalLifecycleStep,
  STEP_RUN_REASON,
  type StepRunId,
  type StepRunReasonCode,
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

export { WAITING_FOR_WORKER_SLOT_MESSAGE } from "./types.js"

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

type HandlerExitError = RunHandlerError | Cause.TimeoutError

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
  readonly github_issue_number: number
  readonly issue_title: string | null
  readonly github_pull_request_number: number | null
  readonly model: string
  readonly variant: string
  readonly review_model: string
  readonly review_variant: string
  readonly state: WorkItemState
  readonly state_ready_at: number
  readonly paused: boolean | number
  readonly waiting_since: number | null
  readonly holds_worker_slot: boolean | number
  readonly pause_before_step: OperationalLifecycleStep | null
  readonly worktree_path: string | null
  readonly starting_commit_oid: string | null
  readonly completion_summary: string | null
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
  issueTitle: row.issue_title,
  githubPullRequestNumber: row.github_pull_request_number,
  model: row.model,
  variant: row.variant,
  reviewModel: row.review_model,
  reviewVariant: row.review_variant,
  state: row.state,
  stateReadyAt: new Date(row.state_ready_at),
  paused: Boolean(row.paused),
  waitingSince:
    row.waiting_since === null || row.waiting_since === undefined
      ? null
      : new Date(row.waiting_since),
  holdsWorkerSlot: Boolean(row.holds_worker_slot),
  pauseBeforeStep: row.pause_before_step,
  worktreePath: row.worktree_path,
  startingCommitOid: row.starting_commit_oid,
  completionSummary: row.completion_summary,
  sessionId: row.session_id,
  failureCode: row.failure_code,
  failureMessage: row.failure_message,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  stateResidenceMs: Math.max(0, nowMs - row.state_ready_at),
  stepRuns,
})

const WORK_ITEM_SELECT_COLUMNS = `id, repository_id, github_issue_number, issue_title, model, variant, review_model,
                   review_variant, state, state_ready_at, paused, waiting_since, holds_worker_slot,
                   pause_before_step, worktree_path, starting_commit_oid, completion_summary, session_id,
                   github_pull_request_number, failure_code,
                   failure_message, created_at, updated_at`

const PR_STATUS_CHECKS_POLL_DELAY = Duration.seconds(30)
const PR_STATUS_CHECKS_MIN_GREEN_WAIT = Duration.seconds(60)
/**
 * When a resumed Work Item sees `no_checks` for a PR head that has been
 * unchanged at least this long, skip the normal grace and confirmation polls.
 * Intentionally longer than the normal 60s + 30s sequence.
 */
const PR_STATUS_CHECKS_STALE_HEAD_NO_CHECK_WAIT = Duration.minutes(2)
/** Stored on a green watch Step Run that requeues for one confirmation poll. */
const PR_STATUS_CHECKS_GREEN_CONFIRMING = "pr_checks_green_confirming"
/** Stored when handled red checks leave the aggregate failed for confirmation. */
const PR_STATUS_CHECKS_FAILED_CONFIRMING = "pr_checks_failed_confirming"

const isStaleNoChecksHead = (
  headPushedAt: Date | null,
  nowMs: number,
): boolean => {
  if (headPushedAt === null) {
    return false
  }
  const pushedMs = headPushedAt.getTime()
  if (!Number.isFinite(pushedMs) || pushedMs > nowMs) {
    return false
  }
  return (
    nowMs - pushedMs >=
    Duration.toMillis(PR_STATUS_CHECKS_STALE_HEAD_NO_CHECK_WAIT)
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
      return "decide_pr_merge"
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
  | AbandonCleanupError
  | WorkItemLifecycleDatabaseError
  | AcknowledgeError
  | JobNotFoundError

export type HumanPrOutcome = "merged" | "closed_unmerged"

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
  | WorkItemLifecycleDatabaseError
  | AcknowledgeError
  | JobNotFoundError

export type PauseError =
  | WorkItemNotFoundError
  | WorkItemTerminalError
  | WorkItemLifecycleDatabaseError
  | AcknowledgeError
  | JobNotFoundError

export type StartError =
  | WorkItemNotFoundError
  | WorkItemTerminalError
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
    githubIssueNumber: number,
  ) => Effect.Effect<WorkItemRecord, ImplementNowError>
  readonly implementLocally: (
    repositoryId: string,
    githubIssueNumber: number,
  ) => Effect.Effect<WorkItemRecord, ImplementNowError>
  readonly runStep: (
    stepRunId: string,
  ) => Effect.Effect<RunStepResult, RunStepError>
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
    githubIssueNumber: number,
  ) => Effect.Effect<readonly WorkItemRecord[], ListWorkItemsError>
  readonly listWorkItemsForRepository: (
    repositoryId: string,
  ) => Effect.Effect<readonly WorkItemRecord[], ListWorkItemsError>
  /**
   * Count unique Work Items with a non-null GitHub PR number and a successful
   * commit Step Run whose finished_at is in the half-open range [fromMs, toMs).
   */
  readonly countCommittedPullRequests: (
    fromMs: number,
    toMs: number,
  ) => Effect.Effect<number, ListWorkItemsError>
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
      )(function* (repositoryId: string, githubIssueNumber: number) {
        const nowMs = yield* Clock.currentTimeMillis
        const rows = (yield* sql
          .unsafe(
            `SELECT ${WORK_ITEM_SELECT_COLUMNS}
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

      const countCommittedPullRequests = Effect.fn(
        "WorkItemLifecycle.countCommittedPullRequests",
      )(function* (fromMs: number, toMs: number) {
        const rows = (yield* sql
          .unsafe(
            `SELECT COUNT(DISTINCT wi.id) AS count
             FROM work_item wi
             INNER JOIN step_run sr ON sr.work_item_id = wi.id
             WHERE wi.github_pull_request_number IS NOT NULL
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
              `SELECT ${WORK_ITEM_SELECT_COLUMNS}
             FROM work_item
             WHERE id = ?
             LIMIT 1`,
              [workItemId],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly WorkItemRow[]
          return rows[0] ?? null
        })

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
                 waiting_since = ?,
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

      const previousWatchPollNote = (
        workItemId: string,
      ): Effect.Effect<string | null, WorkItemLifecycleDatabaseError> =>
        Effect.gen(function* () {
          const rows = (yield* sql
            .unsafe(
              `SELECT reason_message FROM step_run
             WHERE work_item_id = ?
               AND step = 'watch_pr_status_checks'
               AND status = 'succeeded'
             ORDER BY finished_at DESC, rowid DESC
             LIMIT 1`,
              [workItemId],
            )
            .pipe(Effect.mapError(toDatabaseError))) as readonly {
            readonly reason_message: string | null
          }[]
          return rows[0]?.reason_message ?? null
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
          readonly pauseBeforeStep?: OperationalLifecycleStep | null
          readonly sessionId?: string
          readonly githubPullRequestNumber?: number
          readonly handledCheckIds?: readonly string[]
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
            return steps.review(context).pipe(Effect.as({}))
          case "commit":
            return steps.commit(context).pipe(Effect.as({}))
          case "create_pr":
            return steps.createPr(context).pipe(
              Effect.map((githubPullRequestNumber) => ({
                githubPullRequestNumber,
              })),
            )
          case "watch_pr_status_checks":
            return steps.watchPrStatusChecks(context).pipe(
              Effect.flatMap((status) =>
                Effect.gen(function* () {
                  if (
                    typeof status === "object" &&
                    status._tag === "conflict"
                  ) {
                    return {
                      handledCheckIds: status.retiredCheckIds,
                      transition: {
                        nextState: "resolve_pr_merge_conflict" as const,
                      },
                    }
                  }
                  if (status === "handoff_needed") {
                    return {
                      transition: {
                        nextState: "investigate_pr_status_checks" as const,
                      },
                    }
                  }
                  if (status === "closed") {
                    return {
                      transition: {
                        nextState: "needs_human" as const,
                        reason:
                          "The pull request was closed before its status checks succeeded",
                      },
                    }
                  }
                  if (status === "pending") {
                    return {
                      transition: {
                        nextState: "watch_pr_status_checks" as const,
                        delay: PR_STATUS_CHECKS_POLL_DELAY,
                      },
                    }
                  }
                  if (status === "failed") {
                    const priorNote = yield* previousWatchPollNote(workItem.id)
                    if (priorNote !== PR_STATUS_CHECKS_FAILED_CONFIRMING) {
                      return {
                        stepRunNote: PR_STATUS_CHECKS_FAILED_CONFIRMING,
                        transition: {
                          nextState: "watch_pr_status_checks" as const,
                          delay: PR_STATUS_CHECKS_POLL_DELAY,
                        },
                      }
                    }
                    return yield* new PrStatusChecksUnresolvedError({
                      message:
                        "Manual fixing may be required. GitHub status checks remained failed without a new check execution to investigate. Please fix or rerun the checks on GitHub, then click Retry checks.",
                    })
                  }
                  const isNoChecks =
                    typeof status === "object" && status._tag === "no_checks"
                  // no_checks: wait the grace before treating absence as green,
                  // unless the PR head was already pushed long enough ago that a
                  // harness restart should not re-run the full confirmation sequence.
                  if (isNoChecks) {
                    const now = yield* Clock.currentTimeMillis
                    if (isStaleNoChecksHead(status.headPushedAt, now)) {
                      return {
                        transition: {
                          nextState: "mark_pr_ready_for_review" as const,
                        },
                      }
                    }
                    const watchedMs = Math.max(0, now - workItem.state_ready_at)
                    if (
                      watchedMs <
                      Duration.toMillis(PR_STATUS_CHECKS_MIN_GREEN_WAIT)
                    ) {
                      return {
                        transition: {
                          nextState: "watch_pr_status_checks" as const,
                          delay: PR_STATUS_CHECKS_POLL_DELAY,
                        },
                      }
                    }
                  }
                  // succeeded (and no_checks after grace): require two consecutive
                  // green polls so a brief SUCCESS cannot race into merge while a
                  // second check is still starting.
                  if (status === "succeeded" || isNoChecks) {
                    const priorNote = yield* previousWatchPollNote(workItem.id)
                    if (priorNote !== PR_STATUS_CHECKS_GREEN_CONFIRMING) {
                      return {
                        stepRunNote: PR_STATUS_CHECKS_GREEN_CONFIRMING,
                        transition: {
                          nextState: "watch_pr_status_checks" as const,
                          delay: PR_STATUS_CHECKS_POLL_DELAY,
                        },
                      }
                    }
                  }
                  return {
                    transition: {
                      nextState: "mark_pr_ready_for_review" as const,
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
              Effect.map((result) => ({
                handledCheckIds: result.handledCheckIds,
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
          case "mark_pr_ready_for_review":
            return steps.markPrReadyForReview(context).pipe(Effect.as({}))
          case "decide_pr_merge":
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
            return steps.mergePr(context).pipe(Effect.as({}))
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

      const completeSuccessfulStep = (input: {
        readonly stepRun: StepRunRow
        readonly workItem: WorkItemRow
        readonly output: {
          readonly worktreePath?: string | null
          readonly startingCommitOid?: string | null
          readonly completionSummary?: string | null
          readonly pauseBeforeStep?: OperationalLifecycleStep | null
          readonly sessionId?: string
          readonly githubPullRequestNumber?: number
          readonly handledCheckIds?: readonly string[]
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
      }): Effect.Effect<WorkItemRecord, RunStepError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const { stepRun, workItem, output, revalidation } = input
          const transition = output.transition
          const nextStep =
            transition?.nextState ?? nextOperationalStep(stepRun.step)
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
          const sessionId = output.sessionId ?? workItem.session_id
          const githubPullRequestNumber =
            output.githubPullRequestNumber ??
            workItem.github_pull_request_number

          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql.unsafe(
                  `UPDATE step_run
                 SET status = 'succeeded',
                     finished_at = ?,
                     reason_message = ?,
                     updated_at = ?
                 WHERE id = ? AND status = 'running'`,
                  [now, output.stepRunNote ?? null, now, stepRun.id],
                )

                for (const checkId of output.handledCheckIds ?? []) {
                  yield* sql.unsafe(
                    `UPDATE pr_status_check
                       SET handled_at = ?, handled_by_step_run_id = ?, updated_at = ?
                       WHERE id = ? AND work_item_id = ? AND handled_at IS NULL`,
                    [now, stepRun.id, now, checkId, workItem.id],
                  )
                }

                if (!revalidation.ok) {
                  yield* sql.unsafe(
                    `UPDATE work_item
                   SET state = 'failed',
                       state_ready_at = ?,
                       failure_code = ?,
                       failure_message = ?,
                        worktree_path = ?,
                        starting_commit_oid = ?,
                        completion_summary = ?,
                        session_id = ?,
                        github_pull_request_number = ?,
                        holds_worker_slot = 0,
                        waiting_since = NULL,
                        updated_at = ?
                   WHERE id = ?`,
                    [
                      now,
                      revalidation.failureCode,
                      revalidation.failureMessage,
                      worktreePath,
                      startingCommitOid,
                      completionSummary,
                      sessionId,
                      githubPullRequestNumber,
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
                        session_id = ?,
                        github_pull_request_number = ?,
                        holds_worker_slot = 0,
                        waiting_since = NULL,
                        updated_at = ?
                   WHERE id = ?`,
                    [
                      now,
                      worktreePath,
                      startingCommitOid,
                      completionSummary,
                      sessionId,
                      githubPullRequestNumber,
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
                        session_id = ?,
                        github_pull_request_number = ?,
                        holds_worker_slot = 0,
                        waiting_since = NULL,
                        updated_at = ?
                   WHERE id = ?`,
                    [
                      now,
                      transition?.reason ??
                        "OpenCode requested human intervention",
                      worktreePath,
                      startingCommitOid,
                      completionSummary,
                      sessionId,
                      githubPullRequestNumber,
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
                        session_id = ?,
                        github_pull_request_number = ?,
                        updated_at = ?
                   WHERE id = ?`,
                      [
                        nextStep,
                        stateReadyAt,
                        pauseBeforeStep,
                        worktreePath,
                        startingCommitOid,
                        completionSummary,
                        sessionId,
                        githubPullRequestNumber,
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
                        session_id = ?,
                        github_pull_request_number = ?,
                        updated_at = ?
                   WHERE id = ?`,
                      [
                        nextStep,
                        stateReadyAt,
                        pauseBeforeStep,
                        worktreePath,
                        startingCommitOid,
                        completionSummary,
                        sessionId,
                        githubPullRequestNumber,
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
                        session_id = ?,
                        github_pull_request_number = ?,
                        updated_at = ?
                   WHERE id = ?`,
                      [
                        nextStep,
                        stateReadyAt,
                        pauseBeforeStep,
                        worktreePath,
                        startingCommitOid,
                        completionSummary,
                        sessionId,
                        githubPullRequestNumber,
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
              }),
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
              }),
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
                  AND work_item.paused = 0
                  AND work_item.state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')
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

              yield* notifyWorkItemsChanged(workItem.repository_id)

              const maxDuration = maxDurations[stepRun.step]
              const context: LifecycleStepContext = {
                workItemId: workItem.id as WorkItemId,
                repositoryId: workItem.repository_id,
                githubIssueNumber: workItem.github_issue_number,
                model: workItem.model,
                variant: workItem.variant,
                reviewModel: workItem.review_model,
                reviewVariant: workItem.review_variant,
                worktreePath: workItem.worktree_path,
                startingCommitOid: workItem.starting_commit_oid,
                completionSummary: workItem.completion_summary,
                sessionId: workItem.session_id,
                maxDuration,
              }

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
                          Effect.timeout(maxDuration),
                        ),
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

        if (!workItem.paused) {
          return yield* getWorkItem(workItemId)
        }

        const now = yield* Clock.currentTimeMillis
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const startedRows = (yield* sql.unsafe(
                `UPDATE work_item
                  SET paused = 0,
                      updated_at = ?
                  WHERE id = ?
                    AND paused = 1
                    AND state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')
                  RETURNING id, state`,
                [now, workItemId],
              )) as readonly {
                readonly id: string
                readonly state: OperationalLifecycleStep
              }[]

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

              const activeRows = (yield* sql.unsafe(
                `SELECT id FROM step_run
                 WHERE work_item_id = ?
                   AND status IN ('queued', 'running')
                 LIMIT 1`,
                [workItemId],
              )) as readonly { readonly id: string }[]
              if (activeRows[0]) {
                // Running Step Run still holds the slot from Pause-while-running.
                return
              }

              const latestRows = (yield* sql.unsafe(
                `SELECT status FROM step_run
                 WHERE work_item_id = ?
                   AND step = ?
                 ORDER BY queued_at DESC, rowid DESC
                 LIMIT 1`,
                [workItemId, pendingStep],
              )) as readonly { readonly status: string }[]
              const latestStatus = latestRows[0]?.status
              if (latestStatus === "failed" || latestStatus === "interrupted") {
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
      ): LifecycleStepContext => ({
        workItemId: row.id as WorkItemId,
        repositoryId: row.repository_id,
        githubIssueNumber: row.github_issue_number,
        model: row.model,
        variant: row.variant,
        reviewModel: row.review_model,
        reviewVariant: row.review_variant,
        worktreePath: row.worktree_path,
        startingCommitOid: row.starting_commit_oid,
        completionSummary: row.completion_summary,
        sessionId: row.session_id,
      })

      const isDecidePrMergeNeedsHumanHandoff = (
        row: WorkItemRow,
        latestStep: OperationalLifecycleStep | null,
      ): boolean =>
        row.state === "needs_human" &&
        row.github_pull_request_number !== null &&
        latestStep === "decide_pr_merge"

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
            }),
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

      const continueAfterHumanPrOutcome = Effect.fn(
        "WorkItemLifecycle.continueAfterHumanPrOutcome",
      )(function* (workItemId: string, outcome: HumanPrOutcome) {
        const workItem = yield* loadWorkItemRow(workItemId)
        if (!workItem) {
          return yield* new WorkItemNotFoundError({ workItemId })
        }

        const latestStep = yield* loadLatestStep(workItemId)
        if (!isDecidePrMergeNeedsHumanHandoff(workItem, latestStep)) {
          return yield* new NeedsHumanHandoffNotEligibleError({
            workItemId,
            reason:
              "Work Item is not a Decide PR Merge Needs Human handoff with a Work Item PR",
          })
        }

        if (outcome === "closed_unmerged") {
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

        const now = yield* Clock.currentTimeMillis

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const updated = (yield* sql.unsafe(
                `UPDATE work_item
                 SET state = 'local_cleanup',
                     state_ready_at = ?,
                     failure_code = NULL,
                     failure_message = NULL,
                     updated_at = ?
                 WHERE id = ?
                   AND state = 'needs_human'
                 RETURNING id`,
                [now, now, workItemId],
              )) as readonly { readonly id: string }[]

              if (!updated[0]) {
                return yield* new NeedsHumanHandoffNotEligibleError({
                  workItemId,
                  reason: "Work Item is no longer Needs Human",
                })
              }

              const acquired = yield* tryAcquireWorkerSlot(workItemId, now)
              if (!acquired) {
                return
              }

              yield* enqueueStepRunForWorkItem(workItemId, "local_cleanup", now)
            }),
          )
          .pipe(
            Effect.catch(
              (
                error,
              ): Effect.Effect<never, ContinueAfterHumanPrOutcomeError> => {
                if (
                  error instanceof NeedsHumanHandoffNotEligibleError ||
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
                    message: `Unexpected failure resuming after human merge: ${String(error)}`,
                    cause: error,
                  }),
                )
              },
            ),
          )

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
            reviewModel: currentWorkItem.review_model,
            reviewVariant: currentWorkItem.review_variant,
            worktreePath: currentWorkItem.worktree_path,
            startingCommitOid: currentWorkItem.starting_commit_oid,
            completionSummary: currentWorkItem.completion_summary,
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
            `SELECT id, work_item_id, step, status, queue_job_id, queued_at,
                    started_at, finished_at, reason_code, reason_message
             FROM step_run
             WHERE work_item_id = ?
             ORDER BY queued_at DESC, rowid DESC
             LIMIT 1`,
            [workItemId],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly StepRunRow[]
        const latest = latestRows[0]
        const retryableNeedsHumanHandoff =
          workItem.state === "needs_human" &&
          latest?.step === "investigate_pr_status_checks" &&
          latest.status === "succeeded"

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
            : retryableNeedsHumanHandoff
              ? "investigate_pr_status_checks"
              : (workItem.state as OperationalLifecycleStep)

        const activeRows = (yield* sql
          .unsafe(
            `SELECT id, work_item_id, step, status, queue_job_id, queued_at,
                  started_at, finished_at, reason_code, reason_message
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
              `SELECT id, work_item_id, step, status, queue_job_id, queued_at,
                    started_at, finished_at, reason_code, reason_message
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
                yield* sql.unsafe(
                  `UPDATE work_item
                   SET state = ?,
                       state_ready_at = ?,
                       failure_code = NULL,
                       failure_message = NULL,
                       updated_at = ?
                   WHERE id = ?`,
                  [pendingStep, now, now, workItemId],
                )
              }

              if (
                retryableNeedsHumanHandoff &&
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
        githubIssueNumber: number,
        options: {
          readonly pauseBeforeStep: OperationalLifecycleStep | null
        },
      ): Effect.Effect<WorkItemRecord, ImplementNowError> =>
        Effect.gen(function* () {
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
          const repositories = yield* db.listRepositories
          const repository = repositories.find(({ id }) => id === repositoryId)
          const model = repository?.defaultModel ?? config.defaultModel
          const variant = repository?.defaultVariant ?? config.defaultVariant
          if (model === null || variant === null) {
            return yield* new BuildModelNotConfiguredError({
              message: "Select a default build model first",
            })
          }
          const reviewModel =
            repository?.reviewModel ?? config.reviewModel ?? model
          const reviewVariant =
            repository?.reviewVariant ?? config.reviewVariant ?? variant
          const workItemId = makeWorkItemId()
          const now = yield* Clock.currentTimeMillis
          const step: OperationalLifecycleStep = "create_worktree"

          const createdId = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const limit = yield* maxWorkerSlots()
                const occupied = yield* countOccupiedWorkerSlots()
                const admit = occupied < limit

                yield* sql.unsafe(
                  `INSERT INTO work_item (
                 id, repository_id, github_issue_number, model, variant,
                  issue_title, review_model, review_variant, state, state_ready_at, paused,
                  waiting_since, holds_worker_slot,
                  pause_before_step, worktree_path, session_id, failure_code,
                  failure_message, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
                  [
                    workItemId,
                    repositoryId,
                    githubIssueNumber,
                    model,
                    variant,
                    issue.title,
                    reviewModel,
                    reviewVariant,
                    step,
                    now,
                    admit ? null : now,
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
        function* (repositoryId: string, githubIssueNumber: number) {
          return yield* createWorkItem(repositoryId, githubIssueNumber, {
            pauseBeforeStep: null,
          })
        },
      )

      const implementLocally = Effect.fn("WorkItemLifecycle.implementLocally")(
        function* (repositoryId: string, githubIssueNumber: number) {
          return yield* createWorkItem(repositoryId, githubIssueNumber, {
            pauseBeforeStep: "commit",
          })
        },
      )

      return WorkItemLifecycle.of({
        maxDurations,
        recoverOrphanedStepRuns,
        interruptRunningStepRunsFromPriorWorker,
        implementNow,
        implementLocally,
        runStep,
        retry,
        pause,
        start,
        abandon,
        reset,
        getWorkItem,
        listWorkItemsForIssue,
        listWorkItemsForRepository,
        countCommittedPullRequests,
        continueAfterHumanPrOutcome,
        admitWaitingWorkItems,
      })
    }),
  )

export const WorkItemLifecycleLive = makeWorkItemLifecycleLive()
