import { type DateTime, Duration } from "effect"

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
  readonly jobId: string
  readonly queue: string
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
  readonly jobId: string
  readonly queue: string
  readonly payload: A
  readonly attempts: number
  readonly maxAttempts: number
  readonly availableAt: DateTime.Utc
  readonly lockedUntil: DateTime.Utc
}

export interface QueueStats {
  readonly pending: number
  readonly processing: number
  readonly deadLetter: number
}
