import { Data } from "effect"
import type { ParseError } from "effect/ParseResult"

export class EnqueueError extends Data.TaggedError("EnqueueError")<{
  readonly queue: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class ClaimError extends Data.TaggedError("ClaimError")<{
  readonly queue: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class AcknowledgeError extends Data.TaggedError("AcknowledgeError")<{
  readonly jobId: string
  readonly message: string
  readonly cause?: unknown
}> {}

export class JobNotFoundError extends Data.TaggedError("JobNotFoundError")<{
  readonly jobId: string
}> {}

export class InvalidQueueNameError extends Data.TaggedError(
  "InvalidQueueNameError",
)<{
  readonly queueName: string
  readonly message: string
}> {}

/**
 * Error thrown when a job payload fails schema validation.
 */
export class PayloadParseError extends Data.TaggedError("PayloadParseError")<{
  readonly queue: string
  readonly jobId: string
  readonly error: ParseError
}> {}
