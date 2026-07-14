import type { Duration } from "effect"
import { Context, Effect, Option, Schema } from "effect"
import type {
  AcknowledgeError,
  ClaimError,
  EnqueueError,
  JobNotFoundError,
} from "./errors.js"
import { InvalidQueueNameError, PayloadParseError } from "./errors.js"
import type { Job, JobId, Payload, QueueStats, RawJob } from "./types.js"

/**
 * Maximum length for AWS SQS Standard queue names.
 * AWS SQS supports up to 80 characters for Standard queues.
 */
export const MAX_QUEUE_NAME_LENGTH = 80

/**
 * Regular expression to validate queue names according to AWS SQS rules.
 * Queue names may contain:
 * - Uppercase letters: A–Z
 * - Lowercase letters: a–z
 * - Numbers: 0–9
 * - Hyphens: -
 * - Underscores: _
 * - Periods: .
 * Spaces are NOT allowed.
 */
const QUEUE_NAME_REGEX = /^[A-Za-z0-9._-]+$/

/**
 * Validates a queue name against AWS SQS naming rules.
 * Returns an Effect that fails with InvalidQueueNameError if the name is invalid.
 */
export const validateQueueName = (
  queueName: string,
): Effect.Effect<string, InvalidQueueNameError> => {
  if (queueName.length === 0) {
    return Effect.fail(
      new InvalidQueueNameError({
        queueName,
        message: "Queue name cannot be empty (minimum length is 1 character)",
      }),
    )
  }

  if (queueName.length > MAX_QUEUE_NAME_LENGTH) {
    return Effect.fail(
      new InvalidQueueNameError({
        queueName,
        message: `Queue name exceeds maximum length of ${MAX_QUEUE_NAME_LENGTH} characters (got ${queueName.length})`,
      }),
    )
  }

  if (!QUEUE_NAME_REGEX.test(queueName)) {
    return Effect.fail(
      new InvalidQueueNameError({
        queueName,
        message:
          "Queue name contains invalid characters. Only A-Z, a-z, 0-9, hyphens (-), underscores (_), and periods (.) are allowed. Spaces are NOT allowed.",
      }),
    )
  }

  return Effect.succeed(queueName)
}

/**
 * Queue service interface.
 * Implementations provide rawClaim which returns unparsed payloads.
 * Use QueueService.claim() for type-safe payload parsing with a schema.
 *
 * Method Effects have R = never; backends acquire deps once in their Layer.
 */
export interface QueueServiceShape {
  /**
   * Whether enqueue operations should be performed inside database transactions.
   * True for database-backed queues (SQLite, Turso) to avoid lock contention.
   * False for external queues (SQS) that don't participate in DB transactions.
   */
  readonly queueInTransaction: boolean

  /**
   * Add a job to the queue for immediate processing.
   * Returns the job ID.
   *
   * @param options.retryLimit - Maximum retry attempts for this job:
   *   - `0`: No retries - fail immediately on first error
   *   - `1+`: Retry up to this many times after failure
   *   - `undefined`: Use system default (typically 5)
   */
  readonly enqueue: <P extends Payload>(
    queue: string,
    payload: P,
    options?: { readonly retryLimit?: number },
  ) => Effect.Effect<JobId, EnqueueError | InvalidQueueNameError>

  /**
   * Add a job to the queue with a delay before it becomes available.
   * Returns the job ID.
   */
  readonly enqueueWithDelay: <P extends Payload>(
    queue: string,
    payload: P,
    delay: Duration.Duration,
    options?: { readonly retryLimit?: number },
  ) => Effect.Effect<JobId, EnqueueError | InvalidQueueNameError>

  /**
   * Claim the next available job from the queue (raw, unparsed payload).
   * Returns None if no jobs are available.
   * The job becomes invisible to other workers for the visibility timeout.
   */
  readonly rawClaim: (
    queue: string,
    visibilityTimeout?: Duration.Duration,
  ) => Effect.Effect<Option.Option<RawJob>, ClaimError | InvalidQueueNameError>

  /**
   * Mark a job as successfully completed. Removes it from the queue.
   */
  readonly acknowledge: (
    jobId: string,
  ) => Effect.Effect<void, AcknowledgeError | JobNotFoundError>

  /**
   * Mark a job as failed. The job will be retried after becoming
   * visible again, unless max retries is reached.
   * Set `retryable: false` to move the job directly to a terminal/dead-letter
   * state when the backend supports that behavior.
   */
  readonly fail: (
    jobId: string,
    options?: {
      readonly releaseImmediately?: boolean
      readonly retryable?: boolean
    },
  ) => Effect.Effect<void, AcknowledgeError | JobNotFoundError>

  /**
   * Set a new visibility timeout for a job that needs more processing time.
   * The timeout is set to the specified duration from now (absolute, not relative).
   * This matches SQS ChangeMessageVisibility semantics.
   */
  readonly extendVisibility: (
    jobId: string,
    timeout: Duration.Duration,
  ) => Effect.Effect<void, AcknowledgeError | JobNotFoundError>

  /**
   * Get queue statistics (for monitoring).
   */
  readonly getStats: (
    queue: string,
  ) => Effect.Effect<QueueStats, InvalidQueueNameError>
}

export class QueueService extends Context.Service<
  QueueService,
  QueueServiceShape
>()("@ready-for-agent/queue-service/QueueService") {
  /**
   * Claim the next available job from the queue with type-safe payload parsing.
   * Returns None if no jobs are available.
   */
  static claim = <A>(
    queue: string,
    schema: Schema.Decoder<A>,
    visibilityTimeout?: Duration.Duration,
  ): Effect.Effect<
    Option.Option<Job<A>>,
    ClaimError | InvalidQueueNameError | PayloadParseError,
    QueueService
  > =>
    Effect.gen(function* () {
      const service = yield* QueueService
      const rawJobOption = yield* service.rawClaim(queue, visibilityTimeout)

      if (Option.isNone(rawJobOption)) {
        return Option.none()
      }

      const rawJob = rawJobOption.value
      const payload = yield* Schema.decodeUnknownEffect(schema)(
        rawJob.payload,
      ).pipe(
        Effect.mapError(
          (error) =>
            new PayloadParseError({ queue, jobId: rawJob.jobId, error }),
        ),
      )

      return Option.some<Job<A>>({
        jobId: rawJob.jobId,
        queue: rawJob.queue,
        payload,
        attempts: rawJob.attempts,
        maxAttempts: rawJob.maxAttempts,
        availableAt: rawJob.availableAt,
        lockedUntil: rawJob.lockedUntil,
      })
    })
}
