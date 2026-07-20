import { Duration, Effect, Random } from "effect"
import { RepositoryId } from "@ready-for-agent/db-service"
import { QueueService } from "@ready-for-agent/queue-service"

/** High-priority manual / first-refresh Issue Refresh Job queue. */
export const ISSUE_REFRESH_QUEUE = "issue-refresh"

/** Scheduled recurring Issue Polling queue (one keyed entry per Repository). */
export const ISSUE_POLL_QUEUE = "issue-poll"

/** Stable key for the durable Polling Auto-heal Job on the high-priority queue. */
export const POLLING_AUTO_HEAL_KEY = "polling-auto-heal"

export const JOB_RECOVERY_RETRY_LIMIT = 1

/** Base quiet period after a scheduled attempt completes. */
export const ISSUE_POLLING_BASE_SECONDS = 120

/** Inclusive upper bound for additive jitter seconds (0–30). */
export const ISSUE_POLLING_JITTER_SECONDS = 30

/** Default backoff when a Polling Auto-heal Job fails (no tight loop). */
export const POLLING_AUTO_HEAL_BACKOFF = Duration.seconds(5)

const RefreshRepositoryJobPayload = (repositoryId: string) => ({
  _tag: "refresh-repository" as const,
  repositoryId: RepositoryId.make(repositoryId),
})

export const PollingAutoHealJobPayload = {
  _tag: "polling-auto-heal" as const,
}

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

export const enqueueRefreshRepositoryJob = Effect.fn(
  "graphql-api.enqueueRefreshRepositoryJob",
)(function* (repositoryId: string) {
  const queue = yield* QueueService
  return yield* queue.enqueue(
    ISSUE_REFRESH_QUEUE,
    RefreshRepositoryJobPayload(repositoryId),
    { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
  )
})

/**
 * Durably ensure one high-priority Polling Auto-heal Job without awaiting repair.
 * Idempotent: repeated startup does not create an unbounded set of equivalents.
 */
export const enqueuePollingAutoHealJob = Effect.gen(function* () {
  const queue = yield* QueueService
  return yield* queue.ensureKeyed(
    ISSUE_REFRESH_QUEUE,
    POLLING_AUTO_HEAL_KEY,
    PollingAutoHealJobPayload,
    Duration.zero,
    { retryLimit: JOB_RECOVERY_RETRY_LIMIT },
  )
}).pipe(Effect.withSpan("graphql-api.enqueuePollingAutoHealJob"))

/**
 * Ensure one keyed recurring schedule and enqueue a high-priority first refresh.
 * Idempotent for the schedule; every activation enqueues a distinct first refresh.
 */
export const activateRepositoryPolling = Effect.fn(
  "graphql-api.activateRepositoryPolling",
)(function* (repositoryId: string) {
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
export const suspendRepositoryPolling = Effect.fn(
  "graphql-api.suspendRepositoryPolling",
)(function* (repositoryId: string) {
  const queue = yield* QueueService
  yield* queue.removeKeyed(ISSUE_POLL_QUEUE, repositoryId)
})

export interface RepairPollingSchedulesInput {
  readonly credentialedRepositoryIds: ReadonlyArray<string>
  readonly sampleDelay?: Effect.Effect<Duration.Duration>
}

/**
 * Make keyed Issue Poll schedules exactly match credentialed Repositories:
 * remove orphans, add missing entries (with a high-priority first refresh each),
 * preserve existing correct entries and due times.
 */
export const repairPollingSchedules = Effect.fn(
  "graphql-api.repairPollingSchedules",
)(function* (input: RepairPollingSchedulesInput) {
  const queue = yield* QueueService
  const sampleDelay = input.sampleDelay ?? sampleIssuePollingDelay
  const credentialed = new Set(input.credentialedRepositoryIds)
  const existing = yield* queue.listKeyed(ISSUE_POLL_QUEUE)

  for (const entry of existing) {
    if (!credentialed.has(entry.key)) {
      yield* queue.removeKeyed(ISSUE_POLL_QUEUE, entry.key)
    }
  }

  const existingKeys = new Set(
    (yield* queue.listKeyed(ISSUE_POLL_QUEUE)).map((entry) => entry.key),
  )
  const missing = input.credentialedRepositoryIds.filter(
    (id) => !existingKeys.has(id),
  )

  for (const repositoryId of missing) {
    const delay = yield* sampleDelay
    const payload = RefreshRepositoryJobPayload(repositoryId)
    // Enqueue first refresh before ensure so a crash between steps still
    // leaves the Repository in the missing set on the next auto-heal attempt
    // (duplicate first refreshes are allowed; schedules are unique).
    yield* queue.enqueue(ISSUE_REFRESH_QUEUE, payload, {
      retryLimit: JOB_RECOVERY_RETRY_LIMIT,
    })
    yield* queue.ensureKeyed(ISSUE_POLL_QUEUE, repositoryId, payload, delay, {
      retryLimit: JOB_RECOVERY_RETRY_LIMIT,
    })
  }
})
