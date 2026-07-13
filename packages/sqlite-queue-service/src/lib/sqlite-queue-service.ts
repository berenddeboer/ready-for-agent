import { DateTime, Duration, Effect, Layer, Option, Schedule } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { Payload, RawJob } from "@ready-for-agent/queue-service"
import {
  AcknowledgeError,
  ClaimError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_VISIBILITY_TIMEOUT,
  EnqueueError,
  JobNotFoundError,
  QueueService,
  validateQueueName,
} from "@ready-for-agent/queue-service"

const formatSqlError = (error: SqlError): string => {
  const parts: string[] = [error.message]
  let current: unknown = error.cause
  while (current) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>
      if (typeof obj.message === "string") parts.push(obj.message)
      current = obj.cause
    } else if (typeof current === "string") {
      parts.push(current)
      break
    } else break
  }
  return parts.join(" -> ")
}

const isSqliteBusy = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("SQLITE_BUSY") ||
    error.message.includes("database is locked") ||
    error.message.includes("SQL statements in progress"))

const retrySqliteBusy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.addDelay(Schedule.recurs(4), () =>
        Effect.succeed(Duration.millis(50)),
      ),
      while: isSqliteBusy,
    }),
  )

const toUtc = (millis: number): DateTime.Utc => DateTime.makeUnsafe(millis)

type JobRow = {
  readonly id: string
  readonly queue: string
  readonly job_payload: string
  readonly job_attempts: number
  readonly job_retry_limit: number
  readonly available_at: number
  readonly locked_until: number | null
}

const rawJob = (row: JobRow): RawJob => ({
  jobId: row.id,
  queue: row.queue,
  payload: JSON.parse(row.job_payload),
  attempts: row.job_attempts,
  maxAttempts: row.job_retry_limit,
  availableAt: toUtc(row.available_at),
  lockedUntil: toUtc(row.locked_until ?? row.available_at),
})

export const SqliteQueueServiceLive = Layer.succeed(
  QueueService,
  QueueService.of({
    queueInTransaction: true,
    enqueue: <P extends Payload>(
      queue: string,
      payload: P,
      options?: { readonly retryLimit?: number },
    ) =>
      Effect.gen(function* () {
        yield* validateQueueName(queue)
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        const rows = yield* retrySqliteBusy(
          sql.unsafe(
            `INSERT INTO job_queue (id, queue, job_payload, job_retry_limit, available_at, locked_until, created_at, updated_at)
             VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, NULL, ?, ?) RETURNING id`,
            [
              queue,
              JSON.stringify(payload),
              options?.retryLimit === undefined
                ? DEFAULT_MAX_RETRIES
                : options.retryLimit + 1,
              now,
              now,
              now,
            ],
          ),
        ).pipe(
          Effect.mapError(
            (error) =>
              new EnqueueError({
                queue,
                message: `Database error: ${formatSqlError(error)}`,
                cause: error,
              }),
          ),
        )
        const row = rows[0] as { readonly id: string } | undefined
        if (!row)
          return yield* new EnqueueError({
            queue,
            message: "No job ID returned from insert",
          })
        return row.id
      }),
    enqueueWithDelay: <P extends Payload>(
      queue: string,
      payload: P,
      delay: Duration.Duration,
      options?: { readonly retryLimit?: number },
    ) =>
      Effect.gen(function* () {
        yield* validateQueueName(queue)
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        const rows = yield* retrySqliteBusy(
          sql.unsafe(
            `INSERT INTO job_queue (id, queue, job_payload, job_retry_limit, available_at, locked_until, created_at, updated_at)
             VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, NULL, ?, ?) RETURNING id`,
            [
              queue,
              JSON.stringify(payload),
              options?.retryLimit === undefined
                ? DEFAULT_MAX_RETRIES
                : options.retryLimit + 1,
              now + Duration.toMillis(delay),
              now,
              now,
            ],
          ),
        ).pipe(
          Effect.mapError(
            (error) =>
              new EnqueueError({
                queue,
                message: `Database error: ${formatSqlError(error)}`,
                cause: error,
              }),
          ),
        )
        const row = rows[0] as { readonly id: string } | undefined
        if (!row)
          return yield* new EnqueueError({
            queue,
            message: "No job ID returned from insert",
          })
        return row.id
      }),
    rawClaim: (queue: string, visibilityTimeout = DEFAULT_VISIBILITY_TIMEOUT) =>
      Effect.gen(function* () {
        yield* validateQueueName(queue)
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        const lockedUntil = now + Duration.toMillis(visibilityTimeout)
        const rows = yield* retrySqliteBusy(
          sql.withTransaction(
            sql.unsafe(
              `UPDATE job_queue SET locked_until = ?, job_attempts = job_attempts + 1, updated_at = ?
               WHERE id = (
                 SELECT id FROM job_queue
                 WHERE queue = ? AND available_at <= ? AND (locked_until IS NULL OR locked_until <= ?)
                   AND job_attempts < job_retry_limit
                 ORDER BY job_attempts, available_at, id LIMIT 1
               )
               RETURNING id, queue, job_payload, job_attempts, job_retry_limit, available_at, locked_until`,
              [lockedUntil, now, queue, now, now],
            ),
          ),
        ).pipe(
          Effect.mapError(
            (error) =>
              new ClaimError({
                queue,
                message: `Database error: ${formatSqlError(error)}`,
                cause: error,
              }),
          ),
        )
        const row = rows[0] as JobRow | undefined
        return row ? Option.some(rawJob(row)) : Option.none()
      }),
    acknowledge: (jobId: string) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const rows = yield* retrySqliteBusy(
          sql.unsafe("DELETE FROM job_queue WHERE id = ? RETURNING id", [
            jobId,
          ]),
        ).pipe(
          Effect.mapError(
            (error) =>
              new AcknowledgeError({
                jobId,
                message: `Database error: ${formatSqlError(error)}`,
                cause: error,
              }),
          ),
        )
        if (!rows[0]) return yield* new JobNotFoundError({ jobId })
      }),
    fail: (jobId: string, options?) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        const statement =
          options?.retryable === false
            ? "UPDATE job_queue SET job_attempts = job_retry_limit, locked_until = NULL, updated_at = ? WHERE id = ? RETURNING id"
            : options?.releaseImmediately
              ? "UPDATE job_queue SET locked_until = NULL, updated_at = ? WHERE id = ? RETURNING id"
              : "SELECT id FROM job_queue WHERE id = ?"
        const params =
          options?.retryable === false || options?.releaseImmediately
            ? [now, jobId]
            : [jobId]
        const rows = yield* retrySqliteBusy(sql.unsafe(statement, params)).pipe(
          Effect.mapError(
            (error) =>
              new AcknowledgeError({
                jobId,
                message: `Database error: ${formatSqlError(error)}`,
                cause: error,
              }),
          ),
        )
        if (!rows[0]) return yield* new JobNotFoundError({ jobId })
      }),
    extendVisibility: (jobId: string, timeout: Duration.Duration) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        const rows = yield* retrySqliteBusy(
          sql.unsafe(
            "UPDATE job_queue SET locked_until = ?, updated_at = ? WHERE id = ? AND locked_until IS NOT NULL RETURNING id",
            [now + Duration.toMillis(timeout), now, jobId],
          ),
        ).pipe(
          Effect.mapError(
            (error) =>
              new AcknowledgeError({
                jobId,
                message: `Database error: ${formatSqlError(error)}`,
                cause: error,
              }),
          ),
        )
        if (rows[0]) return
        const exists = yield* sql
          .unsafe("SELECT id FROM job_queue WHERE id = ?", [jobId])
          .pipe(
            Effect.mapError(
              (error) =>
                new AcknowledgeError({
                  jobId,
                  message: `Database error: ${formatSqlError(error)}`,
                  cause: error,
                }),
            ),
          )
        if (!exists[0]) return yield* new JobNotFoundError({ jobId })
        return yield* new AcknowledgeError({
          jobId,
          message: "Cannot extend visibility of unlocked job",
        })
      }),
    getStats: (queue: string) =>
      Effect.gen(function* () {
        yield* validateQueueName(queue)
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        const rows = yield* sql
          .unsafe(
            `SELECT
             COUNT(CASE WHEN (locked_until IS NULL OR locked_until <= ?) AND job_attempts < job_retry_limit THEN 1 END) AS pending,
             COUNT(CASE WHEN locked_until > ? THEN 1 END) AS processing,
             COUNT(CASE WHEN job_attempts >= job_retry_limit THEN 1 END) AS deadLetter
           FROM job_queue WHERE queue = ?`,
            [now, now, queue],
          )
          .pipe(Effect.orElseSucceed(() => []))
        return (
          (rows[0] as
            | { pending: number; processing: number; deadLetter: number }
            | undefined) ?? { pending: 0, processing: 0, deadLetter: 0 }
        )
      }),
  }),
)
