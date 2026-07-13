import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm"
import { DateTime, Duration, Effect, Layer, Option, Schedule } from "effect"
import { TypedSqliteDrizzle, runDrizzle } from "@ready-for-agent/db"
import * as schema from "@ready-for-agent/db-schema"
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

/**
 * Extract a meaningful error message from SqlError, including cause chain.
 */
const formatSqlError = (error: SqlError): string => {
  const parts: string[] = [error.message]

  let current: unknown = error.cause
  while (current) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>
      if ("message" in obj && typeof obj["message"] === "string") {
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

const isSqliteBusy = (error: unknown): boolean => {
  let current: unknown = error

  while (current != null) {
    if (current instanceof Error) {
      if (
        current.message.includes("SQLITE_BUSY") ||
        current.message.includes("database is locked") ||
        current.message.includes("SQL statements in progress")
      ) {
        return true
      }
      current = current.cause
      continue
    }

    if (
      typeof current === "object" &&
      current !== null &&
      "message" in current &&
      typeof current.message === "string"
    ) {
      if (
        current.message.includes("SQLITE_BUSY") ||
        current.message.includes("database is locked") ||
        current.message.includes("SQL statements in progress")
      ) {
        return true
      }
      current =
        "cause" in current ? (current as { cause?: unknown }).cause : undefined
      continue
    }

    if (
      typeof current === "string" &&
      (current.includes("SQLITE_BUSY") ||
        current.includes("database is locked") ||
        current.includes("SQL statements in progress"))
    ) {
      return true
    }

    break
  }

  return false
}

const SQLITE_BUSY_RETRY_SCHEDULE = Schedule.addDelay(Schedule.recurs(4), () =>
  Duration.millis(50),
)

const retrySqliteBusy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      schedule: SQLITE_BUSY_RETRY_SCHEDULE,
      while: isSqliteBusy,
    }),
  )

const toUtc = (millis: number): DateTime.Utc => DateTime.unsafeMake(millis)

/**
 * SQLite/Turso implementation of the QueueService.
 *
 * Claim uses SqlClient.withTransaction (BEGIN IMMEDIATE via layer-turso-local)
 * for atomic lock + attempt increment. All operations require TypedSqliteDrizzle.
 */
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
        const db = yield* TypedSqliteDrizzle
        const now = Date.now()

        const result = yield* runDrizzle(
          db
            .insert(schema.jobQueue)
            .values({
              queue,
              jobPayload: payload as Record<string, unknown>,
              jobRetryLimit:
                options?.retryLimit !== undefined
                  ? options.retryLimit + 1
                  : DEFAULT_MAX_RETRIES,
              availableAt: now,
              lockedUntil: null,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: schema.jobQueue.id }),
        ).pipe(
          retrySqliteBusy,
          Effect.catchTag("SqlError", (error: SqlError) => {
            const formattedMsg = formatSqlError(error)
            console.error(
              `[SqliteQueueService] enqueue failed for queue=${queue}:`,
              formattedMsg,
              error,
            )
            return Effect.fail(
              new EnqueueError({
                queue,
                message: `Database error: ${formattedMsg}`,
                cause: error,
              }),
            )
          }),
        )

        const row = result[0]
        if (!row) {
          return yield* new EnqueueError({
            queue,
            message: "No job ID returned from insert",
          })
        }

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
        const db = yield* TypedSqliteDrizzle
        const now = Date.now()
        const availableAt = now + Duration.toMillis(delay)

        const result = yield* runDrizzle(
          db
            .insert(schema.jobQueue)
            .values({
              queue,
              jobPayload: payload as Record<string, unknown>,
              jobRetryLimit:
                options?.retryLimit !== undefined
                  ? options.retryLimit + 1
                  : DEFAULT_MAX_RETRIES,
              availableAt,
              lockedUntil: null,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: schema.jobQueue.id }),
        ).pipe(
          retrySqliteBusy,
          Effect.catchTag("SqlError", (error: SqlError) => {
            const formattedMsg = formatSqlError(error)
            console.error(
              `[SqliteQueueService] enqueueWithDelay failed for queue=${queue}:`,
              formattedMsg,
              error,
            )
            return Effect.fail(
              new EnqueueError({
                queue,
                message: `Database error: ${formattedMsg}`,
                cause: error,
              }),
            )
          }),
        )

        const row = result[0]
        if (!row) {
          return yield* new EnqueueError({
            queue,
            message: "No job ID returned from insert",
          })
        }

        return row.id
      }),

    rawClaim: (queue: string, visibilityTimeout?: Duration.Duration) =>
      Effect.gen(function* () {
        yield* validateQueueName(queue)
        const sqlClient = yield* SqlClient.SqlClient
        const db = yield* TypedSqliteDrizzle
        const now = Date.now()
        const timeout = visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT
        const lockedUntil = now + Duration.toMillis(timeout)

        const availableJobConditions = and(
          eq(schema.jobQueue.queue, queue),
          lte(schema.jobQueue.availableAt, now),
          or(
            isNull(schema.jobQueue.lockedUntil),
            lte(schema.jobQueue.lockedUntil, now),
          ),
          lt(schema.jobQueue.jobAttempts, schema.jobQueue.jobRetryLimit),
        )

        const candidate = yield* runDrizzle(
          db
            .select({ id: schema.jobQueue.id })
            .from(schema.jobQueue)
            .where(availableJobConditions)
            .limit(1),
        ).pipe(
          retrySqliteBusy,
          Effect.catchTag("SqlError", (error: SqlError) => {
            const formattedMsg = formatSqlError(error)
            console.error(
              `[SqliteQueueService] rawClaim (check) failed for queue=${queue}:`,
              formattedMsg,
              error,
            )
            return Effect.fail(
              new ClaimError({
                queue,
                message: `Database error: ${formattedMsg}`,
                cause: error,
              }),
            )
          }),
        )

        if (!candidate[0]) {
          return Option.none()
        }

        // Atomic claim: BEGIN IMMEDIATE (Turso layer) then update under write lock.
        // SQLite/Turso have no FOR UPDATE SKIP LOCKED.
        return yield* sqlClient
          .withTransaction(
            Effect.gen(function* () {
              const nextJobSubquery = db
                .select({ id: schema.jobQueue.id })
                .from(schema.jobQueue)
                .where(availableJobConditions)
                .orderBy(
                  schema.jobQueue.jobAttempts,
                  schema.jobQueue.availableAt,
                  schema.jobQueue.id,
                )
                .limit(1)

              const result = yield* runDrizzle(
                db
                  .update(schema.jobQueue)
                  .set({
                    lockedUntil,
                    jobAttempts: sql`${schema.jobQueue.jobAttempts} + 1`,
                    updatedAt: now,
                  })
                  .where(eq(schema.jobQueue.id, nextJobSubquery))
                  .returning(),
              )

              if (!result[0]) {
                return Option.none()
              }

              const row = result[0]
              return Option.some<RawJob>({
                jobId: row.id,
                queue: row.queue,
                payload: row.jobPayload,
                attempts: row.jobAttempts,
                maxAttempts: row.jobRetryLimit,
                availableAt: toUtc(row.availableAt),
                lockedUntil: toUtc(lockedUntil),
              })
            }),
          )
          .pipe(
            retrySqliteBusy,
            Effect.catchTag("SqlError", (error: SqlError) => {
              const formattedMsg = formatSqlError(error)
              console.error(
                `[SqliteQueueService] rawClaim failed for queue=${queue}:`,
                formattedMsg,
                error,
              )
              return Effect.fail(
                new ClaimError({
                  queue,
                  message: `Database error: ${formattedMsg}`,
                  cause: error,
                }),
              )
            }),
          )
      }),

    acknowledge: (jobId: string) =>
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle

        const result = yield* runDrizzle(
          db
            .delete(schema.jobQueue)
            .where(eq(schema.jobQueue.id, jobId))
            .returning({ id: schema.jobQueue.id }),
        ).pipe(
          retrySqliteBusy,
          Effect.catchTag("SqlError", (error: SqlError) => {
            const formattedMsg = formatSqlError(error)
            console.error(
              `[SqliteQueueService] acknowledge failed for jobId=${jobId}:`,
              formattedMsg,
              error,
            )
            return Effect.fail(
              new AcknowledgeError({
                jobId,
                message: `Database error: ${formattedMsg}`,
                cause: error,
              }),
            )
          }),
        )

        if (!result[0]) {
          return yield* new JobNotFoundError({ jobId })
        }
      }),

    fail: (
      jobId: string,
      options?: {
        readonly releaseImmediately?: boolean
        readonly retryable?: boolean
      },
    ) =>
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const now = Date.now()

        if (options?.retryable === false) {
          const result = yield* runDrizzle(
            db
              .update(schema.jobQueue)
              .set({
                jobAttempts: sql`${schema.jobQueue.jobRetryLimit}`,
                lockedUntil: null,
                updatedAt: now,
              })
              .where(eq(schema.jobQueue.id, jobId))
              .returning({ id: schema.jobQueue.id }),
          ).pipe(
            retrySqliteBusy,
            Effect.catchTag("SqlError", (error: SqlError) => {
              const formattedMsg = formatSqlError(error)
              console.error(
                `[SqliteQueueService] fail (terminal) failed for jobId=${jobId}:`,
                formattedMsg,
                error,
              )
              return Effect.fail(
                new AcknowledgeError({
                  jobId,
                  message: `Failed to dead-letter job: ${formattedMsg}`,
                  cause: error,
                }),
              )
            }),
          )

          if (!result[0]) {
            return yield* new JobNotFoundError({ jobId })
          }

          return
        }

        if (options?.releaseImmediately) {
          const result = yield* runDrizzle(
            db
              .update(schema.jobQueue)
              .set({ lockedUntil: null, updatedAt: now })
              .where(eq(schema.jobQueue.id, jobId))
              .returning({ id: schema.jobQueue.id }),
          ).pipe(
            retrySqliteBusy,
            Effect.catchTag("SqlError", (error: SqlError) => {
              const formattedMsg = formatSqlError(error)
              console.error(
                `[SqliteQueueService] fail (releaseImmediately) failed for jobId=${jobId}:`,
                formattedMsg,
                error,
              )
              return Effect.fail(
                new AcknowledgeError({
                  jobId,
                  message: `Failed to mark job as failed: ${formattedMsg}`,
                  cause: error,
                }),
              )
            }),
          )

          if (!result[0]) {
            return yield* new JobNotFoundError({ jobId })
          }
        } else {
          const result = yield* runDrizzle(
            db
              .select({ id: schema.jobQueue.id })
              .from(schema.jobQueue)
              .where(eq(schema.jobQueue.id, jobId)),
          ).pipe(
            retrySqliteBusy,
            Effect.catchTag("SqlError", (error: SqlError) => {
              const formattedMsg = formatSqlError(error)
              console.error(
                `[SqliteQueueService] fail (verify) failed for jobId=${jobId}:`,
                formattedMsg,
                error,
              )
              return Effect.fail(
                new AcknowledgeError({
                  jobId,
                  message: `Failed to verify job exists: ${formattedMsg}`,
                  cause: error,
                }),
              )
            }),
          )

          if (!result[0]) {
            return yield* new JobNotFoundError({ jobId })
          }
        }
      }),

    extendVisibility: (jobId: string, timeout: Duration.Duration) =>
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        const now = Date.now()
        const newLock = now + Duration.toMillis(timeout)

        const result = yield* runDrizzle(
          db
            .update(schema.jobQueue)
            .set({ lockedUntil: newLock, updatedAt: now })
            .where(
              and(
                eq(schema.jobQueue.id, jobId),
                sql`${schema.jobQueue.lockedUntil} IS NOT NULL`,
              ),
            )
            .returning({ id: schema.jobQueue.id }),
        ).pipe(
          retrySqliteBusy,
          Effect.catchTag("SqlError", (error: SqlError) => {
            const formattedMsg = formatSqlError(error)
            console.error(
              `[SqliteQueueService] extendVisibility failed for jobId=${jobId}:`,
              formattedMsg,
              error,
            )
            return Effect.fail(
              new AcknowledgeError({
                jobId,
                message: `Failed to extend visibility: ${formattedMsg}`,
                cause: error,
              }),
            )
          }),
        )

        if (!result[0]) {
          const exists = yield* runDrizzle(
            db
              .select({ lockedUntil: schema.jobQueue.lockedUntil })
              .from(schema.jobQueue)
              .where(eq(schema.jobQueue.id, jobId)),
          ).pipe(
            retrySqliteBusy,
            Effect.catchTag("SqlError", (error: SqlError) => {
              const formattedMsg = formatSqlError(error)
              console.error(
                `[SqliteQueueService] extendVisibility (verify) failed for jobId=${jobId}:`,
                formattedMsg,
                error,
              )
              return Effect.fail(
                new AcknowledgeError({
                  jobId,
                  message: `Failed to verify job: ${formattedMsg}`,
                  cause: error,
                }),
              )
            }),
          )

          if (!exists[0]) {
            return yield* new JobNotFoundError({ jobId })
          }

          return yield* new AcknowledgeError({
            jobId,
            message: "Cannot extend visibility of unlocked job",
          })
        }
      }),

    getStats: (queue: string) =>
      Effect.gen(function* () {
        yield* validateQueueName(queue)
        const db = yield* TypedSqliteDrizzle
        const now = Date.now()

        const stats = yield* runDrizzle(
          db
            .select({
              pending: sql<number>`COUNT(CASE
              WHEN (${schema.jobQueue.lockedUntil} IS NULL OR ${schema.jobQueue.lockedUntil} <= ${now})
                AND ${schema.jobQueue.jobAttempts} < ${schema.jobQueue.jobRetryLimit}
              THEN 1 END)`,
              processing: sql<number>`COUNT(CASE
              WHEN ${schema.jobQueue.lockedUntil} > ${now}
              THEN 1 END)`,
              deadLetter: sql<number>`COUNT(CASE
              WHEN ${schema.jobQueue.jobAttempts} >= ${schema.jobQueue.jobRetryLimit}
              THEN 1 END)`,
            })
            .from(schema.jobQueue)
            .where(eq(schema.jobQueue.queue, queue)),
        ).pipe(Effect.orElseSucceed(() => [] as const))

        return (
          stats[0] ?? {
            pending: 0,
            processing: 0,
            deadLetter: 0,
          }
        )
      }),
  }),
)
