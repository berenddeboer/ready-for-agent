import { type DateTime, Duration, Schema } from "effect"
import { ulid } from "ulidx"

export const JobId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^qjob-[0-9A-HJKMNP-TV-Z]{26}$/)),
  Schema.brand("JobId"),
)
export type JobId = typeof JobId.Type

export const makeJobId = (): JobId => JobId.make(`qjob-${ulid()}`)

export type Payload = Record<string, unknown>

/** Default visibility timeout for claimed jobs */
export const DEFAULT_VISIBILITY_TIMEOUT = Duration.seconds(30)

/** Default maximum retry attempts before moving to dead letter */
export const DEFAULT_MAX_RETRIES = 5

/**
 * A raw job as returned from the database/queue before schema parsing.
 * The payload is unknown and needs to be parsed with a schema.
 */
export interface RawJob {
  readonly jobId: JobId
  readonly queue: string
  readonly key: string | null
  readonly payload: unknown
  readonly attempts: number
  readonly maxAttempts: number
  readonly availableAt: DateTime.Utc
  readonly lockedUntil: DateTime.Utc
}

/**
 * A job with a typed payload after schema parsing.
 */
export interface Job<A> {
  readonly jobId: JobId
  readonly queue: string
  readonly key: string | null
  readonly payload: A
  readonly attempts: number
  readonly maxAttempts: number
  readonly availableAt: DateTime.Utc
  readonly lockedUntil: DateTime.Utc
}

/**
 * A durable keyed queue entry for inspection (recurring schedules).
 */
export interface KeyedQueueEntry {
  readonly jobId: JobId
  readonly queue: string
  readonly key: string
  readonly payload: unknown
  readonly attempts: number
  readonly maxAttempts: number
  readonly availableAt: DateTime.Utc
  readonly lockedUntil: DateTime.Utc | null
}

/**
 * Result of ensuring a keyed entry: one durable identity, with create signal.
 */
export interface EnsureKeyedResult {
  readonly jobId: JobId
  readonly created: boolean
}

export interface QueueStats {
  readonly pending: number
  readonly processing: number
  readonly deadLetter: number
}
