import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type {
  EnsureKeyedResult,
  KeyedQueueEntry,
  Payload,
  RawJob,
} from "@ready-for-agent/queue-service"
import {
  AcknowledgeError,
  ClaimError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_VISIBILITY_TIMEOUT,
  EnqueueError,
  JobId,
  JobNotFoundError,
  QueueReadError,
  QueueService,
  makeJobId,
  validateJobKey,
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

const isSqliteBusy = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const message = error.message
  return (
    message.includes("SQLITE_BUSY") ||
    message.includes("database is locked") ||
    message.includes("SQL statements in progress") ||
    message.includes("CONCURRENT")
  )
}

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

const retryLimitFromOptions = (options?: {
  readonly retryLimit?: number
}): number =>
  options?.retryLimit === undefined
    ? DEFAULT_MAX_RETRIES
    : options.retryLimit + 1

const JobSqlRow = Schema.Struct({
  id: Schema.String,
  queue: Schema.String,
  key: Schema.NullOr(Schema.String),
  jobPayload: Schema.String,
  jobAttempts: Schema.Finite,
  jobRetryLimit: Schema.Finite,
  availableAt: Schema.Finite,
  lockedUntil: Schema.NullOr(Schema.Finite),
}).pipe(
  Schema.encodeKeys({
    jobPayload: "job_payload",
    jobAttempts: "job_attempts",
    jobRetryLimit: "job_retry_limit",
    availableAt: "available_at",
    lockedUntil: "locked_until",
  }),
)
type JobSqlRow = typeof JobSqlRow.Type

const IdSqlRow = Schema.Struct({
  id: Schema.String,
})

const KeyedLockSqlRow = Schema.Struct({
  id: Schema.String,
  key: Schema.NullOr(Schema.String),
  lockedUntil: Schema.NullOr(Schema.Finite),
}).pipe(
  Schema.encodeKeys({
    lockedUntil: "locked_until",
  }),
)

const StatsSqlRow = Schema.Struct({
  pending: Schema.Finite,
  processing: Schema.Finite,
  deadLetter: Schema.Finite,
})

const decodeJobRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(JobSqlRow))(rows)

const decodeIdRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(IdSqlRow))(rows)

const decodeKeyedLockRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(KeyedLockSqlRow))(rows)

const decodeStatsRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(StatsSqlRow))(rows)

class JsonParseError extends Schema.TaggedErrorClass<JsonParseError>()(
  "JsonParseError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const parseJsonPayload = (raw: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new JsonParseError({
        message:
          cause instanceof Error ? cause.message : "Failed to parse JSON",
        cause,
      }),
  })

const rawJobFromRow = (row: JobSqlRow): Effect.Effect<RawJob, JsonParseError> =>
  Effect.gen(function* () {
    const payload = yield* parseJsonPayload(row.jobPayload)
    return {
      jobId: JobId.make(row.id),
      queue: row.queue,
      key: row.key,
      payload,
      attempts: row.jobAttempts,
      maxAttempts: row.jobRetryLimit,
      availableAt: toUtc(row.availableAt),
      lockedUntil: toUtc(row.lockedUntil ?? row.availableAt),
    } satisfies RawJob
  })

const keyedEntryFromRow = (
  row: JobSqlRow,
): Effect.Effect<KeyedQueueEntry, JsonParseError> =>
  Effect.gen(function* () {
    const payload = yield* parseJsonPayload(row.jobPayload)
    return {
      jobId: JobId.make(row.id),
      queue: row.queue,
      key: row.key as string,
      payload,
      attempts: row.jobAttempts,
      maxAttempts: row.jobRetryLimit,
      availableAt: toUtc(row.availableAt),
      lockedUntil: row.lockedUntil === null ? null : toUtc(row.lockedUntil),
    } satisfies KeyedQueueEntry
  })

const toEnqueueError = (queue: string, error: SqlError) =>
  new EnqueueError({
    queue,
    message: `Database error: ${formatSqlError(error)}`,
    cause: error,
  })

const toClaimError = (queue: string, error: SqlError) =>
  new ClaimError({
    queue,
    message: `Database error: ${formatSqlError(error)}`,
    cause: error,
  })

const toAcknowledgeError = (jobId: string, error: SqlError) =>
  new AcknowledgeError({
    jobId,
    message: `Database error: ${formatSqlError(error)}`,
    cause: error,
  })

const toQueueReadSqlError = (queue: string, error: SqlError) =>
  new QueueReadError({
    queue,
    message: `Database error: ${formatSqlError(error)}`,
    cause: error,
  })

const toQueueReadSchemaError = (queue: string, error: Schema.SchemaError) =>
  new QueueReadError({
    queue,
    message: `Database row shape error: ${error.message}`,
    cause: error,
  })

const toClaimSchemaError = (queue: string, error: Schema.SchemaError) =>
  new ClaimError({
    queue,
    message: `Database row shape error: ${error.message}`,
    cause: error,
  })

const toEnqueueSchemaError = (queue: string, error: Schema.SchemaError) =>
  new EnqueueError({
    queue,
    message: `Database row shape error: ${error.message}`,
    cause: error,
  })

const toAcknowledgeSchemaError = (jobId: string, error: Schema.SchemaError) =>
  new AcknowledgeError({
    jobId,
    message: `Database row shape error: ${error.message}`,
    cause: error,
  })

export const SqliteQueueServiceLive = Layer.effect(
  QueueService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return QueueService.of({
      queueInTransaction: true,
      enqueue: <P extends Payload>(
        queue: string,
        payload: P,
        options?: { readonly retryLimit?: number },
      ) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const now = yield* Clock.currentTimeMillis
          const jobId = makeJobId()
          const rows = yield* retrySqliteBusy(
            sql.unsafe(
              `INSERT INTO job_queue (id, queue, job_payload, job_retry_limit, available_at, locked_until, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, NULL, ?, ?) RETURNING id`,
              [
                jobId,
                queue,
                JSON.stringify(payload),
                retryLimitFromOptions(options),
                now,
                now,
                now,
              ],
            ),
          ).pipe(Effect.mapError((error) => toEnqueueError(queue, error)))
          const decoded = yield* decodeIdRows(rows).pipe(
            Effect.mapError((error) => toEnqueueSchemaError(queue, error)),
          )
          const row = decoded[0]
          if (!row)
            return yield* new EnqueueError({
              queue,
              message: "No job ID returned from insert",
            })
          return JobId.make(row.id)
        }),
      enqueueWithDelay: <P extends Payload>(
        queue: string,
        payload: P,
        delay: Duration.Duration,
        options?: { readonly retryLimit?: number },
      ) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const now = yield* Clock.currentTimeMillis
          const jobId = makeJobId()
          const rows = yield* retrySqliteBusy(
            sql.unsafe(
              `INSERT INTO job_queue (id, queue, job_payload, job_retry_limit, available_at, locked_until, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, NULL, ?, ?) RETURNING id`,
              [
                jobId,
                queue,
                JSON.stringify(payload),
                retryLimitFromOptions(options),
                now + Duration.toMillis(delay),
                now,
                now,
              ],
            ),
          ).pipe(Effect.mapError((error) => toEnqueueError(queue, error)))
          const decoded = yield* decodeIdRows(rows).pipe(
            Effect.mapError((error) => toEnqueueSchemaError(queue, error)),
          )
          const row = decoded[0]
          if (!row)
            return yield* new EnqueueError({
              queue,
              message: "No job ID returned from insert",
            })
          return JobId.make(row.id)
        }),
      ensureKeyed: <P extends Payload>(
        queue: string,
        key: string,
        payload: P,
        delay: Duration.Duration,
        options?: { readonly retryLimit?: number },
      ) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          yield* validateJobKey(key)
          const now = yield* Clock.currentTimeMillis
          const jobId = makeJobId()
          const availableAt = now + Duration.toMillis(delay)
          const result = yield* retrySqliteBusy(
            sql.withTransaction(
              Effect.gen(function* () {
                const inserted = yield* sql.unsafe(
                  `INSERT INTO job_queue (id, queue, key, job_payload, job_retry_limit, available_at, locked_until, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
                   ON CONFLICT(queue, key) WHERE key IS NOT NULL DO NOTHING
                   RETURNING id`,
                  [
                    jobId,
                    queue,
                    key,
                    JSON.stringify(payload),
                    retryLimitFromOptions(options),
                    availableAt,
                    now,
                    now,
                  ],
                )
                const insertedDecoded = yield* decodeIdRows(inserted).pipe(
                  Effect.mapError((error) =>
                    toEnqueueSchemaError(queue, error),
                  ),
                )
                const insertedRow = insertedDecoded[0]
                if (insertedRow) {
                  return {
                    jobId: JobId.make(insertedRow.id),
                    created: true,
                  } satisfies EnsureKeyedResult
                }
                const existing = yield* sql.unsafe(
                  `SELECT id FROM job_queue WHERE queue = ? AND key = ?`,
                  [queue, key],
                )
                const existingDecoded = yield* decodeIdRows(existing).pipe(
                  Effect.mapError((error) =>
                    toEnqueueSchemaError(queue, error),
                  ),
                )
                const existingRow = existingDecoded[0]
                if (!existingRow) {
                  return yield* new EnqueueError({
                    queue,
                    message: `Keyed entry not found after conflict for key ${key}`,
                  })
                }
                return {
                  jobId: JobId.make(existingRow.id),
                  created: false,
                } satisfies EnsureKeyedResult
              }),
            ),
          ).pipe(
            Effect.mapError((error) =>
              error instanceof EnqueueError
                ? error
                : toEnqueueError(queue, error as SqlError),
            ),
          )
          return result
        }),
      listKeyed: (queue: string) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const rows = yield* sql
            .unsafe(
              `SELECT id, queue, key, job_payload, job_attempts, job_retry_limit, available_at, locked_until
               FROM job_queue
               WHERE queue = ? AND key IS NOT NULL
               ORDER BY key, id`,
              [queue],
            )
            .pipe(Effect.mapError((error) => toQueueReadSqlError(queue, error)))
          const decoded = yield* decodeJobRows(rows).pipe(
            Effect.mapError((error) => toQueueReadSchemaError(queue, error)),
          )
          return yield* Effect.forEach(decoded, (row) =>
            keyedEntryFromRow(row).pipe(
              Effect.mapError(
                (cause) =>
                  new QueueReadError({
                    queue,
                    message: `Failed to parse job payload for job ${row.id}`,
                    cause,
                  }),
              ),
            ),
          )
        }),
      reviveExhaustedKeyed: (queue: string) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const now = yield* Clock.currentTimeMillis
          yield* retrySqliteBusy(
            sql.unsafe(
              `UPDATE job_queue
               SET locked_until = NULL,
                   job_attempts = 0,
                   available_at = ?,
                   updated_at = ?
               WHERE queue = ?
                 AND key IS NOT NULL
                 AND job_attempts >= job_retry_limit`,
              [now, now, queue],
            ),
          ).pipe(Effect.mapError((error) => toEnqueueError(queue, error)))
        }),
      postponeKeyed: (jobId: string, delay: Duration.Duration) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const availableAt = now + Duration.toMillis(delay)
          const rows = yield* retrySqliteBusy(
            sql.unsafe(
              `UPDATE job_queue
               SET locked_until = NULL,
                   job_attempts = 0,
                   available_at = ?,
                   updated_at = ?
               WHERE id = ?
                 AND key IS NOT NULL
                 AND locked_until IS NOT NULL
               RETURNING id`,
              [availableAt, now, jobId],
            ),
          ).pipe(Effect.mapError((error) => toAcknowledgeError(jobId, error)))
          const updated = yield* decodeIdRows(rows).pipe(
            Effect.mapError((error) => toAcknowledgeSchemaError(jobId, error)),
          )
          if (updated[0]) return
          const existing = yield* sql
            .unsafe(
              `SELECT id, key, locked_until FROM job_queue WHERE id = ?`,
              [jobId],
            )
            .pipe(Effect.mapError((error) => toAcknowledgeError(jobId, error)))
          const decoded = yield* decodeKeyedLockRows(existing).pipe(
            Effect.mapError((error) => toAcknowledgeSchemaError(jobId, error)),
          )
          const row = decoded[0]
          if (!row) return yield* new JobNotFoundError({ jobId })
          if (row.key === null) {
            return yield* new AcknowledgeError({
              jobId,
              message: "Cannot postpone an unkeyed job",
            })
          }
          return yield* new AcknowledgeError({
            jobId,
            message: "Cannot postpone an unclaimed keyed job",
          })
        }),
      removeKeyed: (queue: string, key: string) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          yield* validateJobKey(key)
          yield* retrySqliteBusy(
            sql.unsafe(`DELETE FROM job_queue WHERE queue = ? AND key = ?`, [
              queue,
              key,
            ]),
          ).pipe(Effect.mapError((error) => toEnqueueError(queue, error)))
        }),
      rawClaim: (
        queue: string,
        visibilityTimeout = DEFAULT_VISIBILITY_TIMEOUT,
      ) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const now = yield* Clock.currentTimeMillis
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
                 RETURNING id, queue, key, job_payload, job_attempts, job_retry_limit, available_at, locked_until`,
                [lockedUntil, now, queue, now, now],
              ),
            ),
          ).pipe(Effect.mapError((error) => toClaimError(queue, error)))
          const decoded = yield* decodeJobRows(rows).pipe(
            Effect.mapError((error) => toClaimSchemaError(queue, error)),
          )
          const row = decoded[0]
          if (!row) return Option.none()
          const job = yield* rawJobFromRow(row).pipe(
            Effect.mapError(
              (cause) =>
                new ClaimError({
                  queue,
                  message: `Failed to parse job payload for job ${row.id}`,
                  cause,
                }),
            ),
          )
          return Option.some(job)
        }),
      acknowledge: (jobId: string) =>
        Effect.gen(function* () {
          const rows = yield* retrySqliteBusy(
            sql.unsafe("DELETE FROM job_queue WHERE id = ? RETURNING id", [
              jobId,
            ]),
          ).pipe(Effect.mapError((error) => toAcknowledgeError(jobId, error)))
          const decoded = yield* decodeIdRows(rows).pipe(
            Effect.mapError((error) => toAcknowledgeSchemaError(jobId, error)),
          )
          if (!decoded[0]) return yield* new JobNotFoundError({ jobId })
        }),
      fail: (jobId: string, options?) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
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
          const rows = yield* retrySqliteBusy(
            sql.unsafe(statement, params),
          ).pipe(Effect.mapError((error) => toAcknowledgeError(jobId, error)))
          const decoded = yield* decodeIdRows(rows).pipe(
            Effect.mapError((error) => toAcknowledgeSchemaError(jobId, error)),
          )
          if (!decoded[0]) return yield* new JobNotFoundError({ jobId })
        }),
      extendVisibility: (jobId: string, timeout: Duration.Duration) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const rows = yield* retrySqliteBusy(
            sql.unsafe(
              "UPDATE job_queue SET locked_until = ?, updated_at = ? WHERE id = ? AND locked_until IS NOT NULL RETURNING id",
              [now + Duration.toMillis(timeout), now, jobId],
            ),
          ).pipe(Effect.mapError((error) => toAcknowledgeError(jobId, error)))
          const updated = yield* decodeIdRows(rows).pipe(
            Effect.mapError((error) => toAcknowledgeSchemaError(jobId, error)),
          )
          if (updated[0]) return
          const exists = yield* sql
            .unsafe("SELECT id FROM job_queue WHERE id = ?", [jobId])
            .pipe(Effect.mapError((error) => toAcknowledgeError(jobId, error)))
          const decoded = yield* decodeIdRows(exists).pipe(
            Effect.mapError((error) => toAcknowledgeSchemaError(jobId, error)),
          )
          if (!decoded[0]) return yield* new JobNotFoundError({ jobId })
          return yield* new AcknowledgeError({
            jobId,
            message: "Cannot extend visibility of unlocked job",
          })
        }),
      getStats: (queue: string) =>
        Effect.gen(function* () {
          yield* validateQueueName(queue)
          const now = yield* Clock.currentTimeMillis
          const rows = yield* sql
            .unsafe(
              `SELECT
               COUNT(CASE WHEN (locked_until IS NULL OR locked_until <= ?) AND job_attempts < job_retry_limit THEN 1 END) AS pending,
               COUNT(CASE WHEN locked_until > ? THEN 1 END) AS processing,
               COUNT(CASE WHEN job_attempts >= job_retry_limit THEN 1 END) AS deadLetter
             FROM job_queue WHERE queue = ?`,
              [now, now, queue],
            )
            .pipe(Effect.mapError((error) => toQueueReadSqlError(queue, error)))
          const decoded = yield* decodeStatsRows(rows).pipe(
            Effect.mapError((error) => toQueueReadSchemaError(queue, error)),
          )
          return decoded[0] ?? { pending: 0, processing: 0, deadLetter: 0 }
        }),
      requeueByPayloadTag: (
        fromQueue: string,
        toQueue: string,
        payloadTag: string,
      ) =>
        Effect.gen(function* () {
          yield* validateQueueName(fromQueue)
          yield* validateQueueName(toQueue)
          if (fromQueue === toQueue) return 0
          const now = yield* Clock.currentTimeMillis
          const rows = yield* retrySqliteBusy(
            sql.unsafe(
              `UPDATE job_queue
               SET queue = ?, updated_at = ?
               WHERE queue = ?
                 AND json_extract(job_payload, '$._tag') = ?
               RETURNING id`,
              [toQueue, now, fromQueue, payloadTag],
            ),
          ).pipe(Effect.mapError((error) => toEnqueueError(toQueue, error)))
          return rows.length
        }),
    })
  }),
)
