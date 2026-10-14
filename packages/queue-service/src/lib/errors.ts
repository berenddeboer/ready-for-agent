import { Schema } from "effect"

export class EnqueueError extends Schema.TaggedError<EnqueueError>()(
  "EnqueueError",
  {
    queue: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ClaimError extends Schema.TaggedError<ClaimError>()("ClaimError", {
  queue: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class AcknowledgeError extends Schema.TaggedError<AcknowledgeError>()(
  "AcknowledgeError",
  {
    jobId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class JobNotFoundError extends Schema.TaggedError<JobNotFoundError>()(
  "JobNotFoundError",
  { jobId: Schema.String },
) {}

export class InvalidQueueNameError extends Schema.TaggedError<InvalidQueueNameError>()(
  "InvalidQueueNameError",
  {
    queueName: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Error thrown when a job payload fails schema validation.
 */
export class PayloadParseError extends Schema.TaggedError<PayloadParseError>()(
  "PayloadParseError",
  {
    queue: Schema.String,
    jobId: Schema.String,
    error: Schema.Defect(),
  },
) {}

/**
 * Error thrown when a job key is empty or otherwise invalid.
 */
export class InvalidJobKeyError extends Schema.TaggedError<InvalidJobKeyError>()(
  "InvalidJobKeyError",
  {
    key: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Error thrown when a queue read/inspect operation fails (list, stats).
 */
export class QueueReadError extends Schema.TaggedError<QueueReadError>()(
  "QueueReadError",
  {
    queue: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
