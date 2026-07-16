import { Schema } from "effect"

export class EnqueueError extends Schema.TaggedErrorClass<EnqueueError>()(
  "EnqueueError",
  {
    queue: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ClaimError extends Schema.TaggedErrorClass<ClaimError>()(
  "ClaimError",
  {
    queue: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class AcknowledgeError extends Schema.TaggedErrorClass<AcknowledgeError>()(
  "AcknowledgeError",
  {
    jobId: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class JobNotFoundError extends Schema.TaggedErrorClass<JobNotFoundError>()(
  "JobNotFoundError",
  { jobId: Schema.String },
) {}

export class InvalidQueueNameError extends Schema.TaggedErrorClass<InvalidQueueNameError>()(
  "InvalidQueueNameError",
  {
    queueName: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Error thrown when a job payload fails schema validation.
 */
export class PayloadParseError extends Schema.TaggedErrorClass<PayloadParseError>()(
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
export class InvalidJobKeyError extends Schema.TaggedErrorClass<InvalidJobKeyError>()(
  "InvalidJobKeyError",
  {
    key: Schema.String,
    message: Schema.String,
  },
) {}
