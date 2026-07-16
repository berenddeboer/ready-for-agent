import { Duration, Effect, Random } from "effect"
import { RepositoryId } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"

/** High-priority manual / first-refresh Issue Refresh Job queue. */
export const ISSUE_REFRESH_QUEUE = "issue-refresh"

/** Scheduled recurring Issue Polling queue (one keyed entry per Repository). */
export const ISSUE_POLL_QUEUE = "issue-poll"

export const JOB_RECOVERY_RETRY_LIMIT = 1

/** Base quiet period after a scheduled attempt completes. */
export const ISSUE_POLLING_BASE_SECONDS = 120

/** Inclusive upper bound for additive jitter seconds (0–30). */
export const ISSUE_POLLING_JITTER_SECONDS = 30

const RefreshRepositoryJobPayload = (repositoryId: string) => ({
  _tag: "refresh-repository" as const,
  repositoryId: RepositoryId.make(repositoryId),
})

/**
 * Sample the next Issue Polling delay: 120s + uniform integer jitter in [0, 30].
 * Injectable via Effect Random so tests can seed or replace sampling.
 */
export const sampleIssuePollingDelay: Effect.Effect<Duration.Duration> =
  Random.nextIntBetween(0, ISSUE_POLLING_JITTER_SECONDS).pipe(
    Effect.map((jitterSeconds) =>
      Duration.seconds(ISSUE_POLLING_BASE_SECONDS + jitterSeconds),
    ),
  )

export const enqueueRefreshRepositoryJob = (repositoryId: string) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    return yield* queue.enqueue(
      ISSUE_REFRESH_QUEUE,
      RefreshRepositoryJobPayload(repositoryId),
      { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
    )
  })

/**
 * Ensure one keyed recurring schedule and enqueue a high-priority first refresh.
 * Idempotent for the schedule; every activation enqueues a distinct first refresh.
 */
export const activateRepositoryPolling = (repositoryId: string) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    const delay = yield* sampleIssuePollingDelay
    const payload = RefreshRepositoryJobPayload(repositoryId)
    yield* queue.ensureKeyed(ISSUE_POLL_QUEUE, repositoryId, payload, delay, {
      retryLimit: JOB_RECOVERY_RETRY_LIMIT,
    })
    return yield* queue.enqueue(ISSUE_REFRESH_QUEUE, payload, {
      retryLimit: JOB_RECOVERY_RETRY_LIMIT,
    })
  })

/** Suspend the recurring schedule without cancelling accepted manual Refresh Jobs. */
export const suspendRepositoryPolling = (repositoryId: string) =>
  Effect.gen(function* () {
    const queue = yield* QueueService
    yield* queue.removeKeyed(ISSUE_POLL_QUEUE, repositoryId)
  })
