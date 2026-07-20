import {
  DateTime,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Random,
} from "effect"
import {
  QueueService,
  type QueueServiceShape,
  makeJobId,
} from "@ready-for-agent/queue-service"
import {
  ISSUE_POLLING_BASE_SECONDS,
  ISSUE_POLLING_JITTER_SECONDS,
  ISSUE_POLL_QUEUE,
  ISSUE_REFRESH_QUEUE,
  activateRepositoryPolling,
  repairPollingSchedules,
  suspendRepositoryPolling,
} from "../src/lib/issue-polling.js"
import { describe, expect, test } from "bun:test"

const makeQueueRuntime = (queue: QueueServiceShape) =>
  ManagedRuntime.make(Layer.succeed(QueueService, queue))

const repo1 = "repo-01J00000000000000000000001"
const repoKeep = "repo-01J00000000000000000000002"
const repoOrphan = "repo-01J00000000000000000000003"
const repoAdded = "repo-01J00000000000000000000004"

const unusedQueue: QueueServiceShape = {
  queueInTransaction: true,
  enqueue: () => Effect.die("not used"),
  enqueueWithDelay: () => Effect.die("not used"),
  ensureKeyed: () => Effect.die("not used"),
  listKeyed: () => Effect.die("not used"),
  reviveExhaustedKeyed: () => Effect.die("not used"),
  postponeKeyed: () => Effect.die("not used"),
  removeKeyed: () => Effect.die("not used"),
  rawClaim: () => Effect.die("not used"),
  acknowledge: () => Effect.die("not used"),
  fail: () => Effect.die("not used"),
  extendVisibility: () => Effect.die("not used"),
  getStats: () => Effect.die("not used"),
  requeueByPayloadTag: () => Effect.succeed(0),
}

describe("issue-polling", () => {
  test("activateRepositoryPolling ensures keyed schedule and first refresh", async () => {
    const ensured: Array<{
      queue: string
      key: string
      delay: Duration.Duration
    }> = []
    const enqueued: Array<{ queue: string; payload: unknown }> = []
    const runtime = makeQueueRuntime({
      ...unusedQueue,
      enqueue: (queueName, payload) =>
        Effect.sync(() => {
          enqueued.push({ queue: queueName, payload })
          return makeJobId()
        }),
      ensureKeyed: (queueName, key, _payload, delay) =>
        Effect.sync(() => {
          ensured.push({ queue: queueName, key, delay })
          return { jobId: makeJobId(), created: true }
        }),
    })

    try {
      await runtime.runPromise(
        activateRepositoryPolling(repo1).pipe(Random.withSeed(1)),
      )

      expect(ensured).toHaveLength(1)
      expect(ensured[0]?.queue).toBe(ISSUE_POLL_QUEUE)
      expect(ensured[0]?.key).toBe(repo1)
      const delaySeconds = Duration.toSeconds(ensured[0]!.delay)
      expect(delaySeconds).toBeGreaterThanOrEqual(ISSUE_POLLING_BASE_SECONDS)
      expect(delaySeconds).toBeLessThanOrEqual(
        ISSUE_POLLING_BASE_SECONDS + ISSUE_POLLING_JITTER_SECONDS,
      )
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0]?.queue).toBe(ISSUE_REFRESH_QUEUE)
      expect(enqueued[0]?.payload).toMatchObject({
        _tag: "refresh-repository",
        repositoryId: repo1,
      })
    } finally {
      await runtime.dispose()
    }
  })

  test("suspendRepositoryPolling removes the keyed schedule", async () => {
    const removed: Array<{ queue: string; key: string }> = []
    const runtime = makeQueueRuntime({
      ...unusedQueue,
      removeKeyed: (queueName, key) =>
        Effect.sync(() => {
          removed.push({ queue: queueName, key })
        }),
    })

    try {
      await runtime.runPromise(suspendRepositoryPolling(repo1))
      expect(removed).toEqual([{ queue: ISSUE_POLL_QUEUE, key: repo1 }])
    } finally {
      await runtime.dispose()
    }
  })

  test("repairPollingSchedules removes orphans and adds missing schedules", async () => {
    const keyed = new Set([repoOrphan, repoKeep])
    const removed: string[] = []
    const ensured: string[] = []
    const enqueued: string[] = []
    const runtime = makeQueueRuntime({
      ...unusedQueue,
      enqueue: (_queue, payload) =>
        Effect.sync(() => {
          const body = payload as { repositoryId: string }
          enqueued.push(body.repositoryId)
          return makeJobId()
        }),
      ensureKeyed: (_queue, key) =>
        Effect.sync(() => {
          ensured.push(key)
          keyed.add(key)
          return { jobId: makeJobId(), created: true }
        }),
      listKeyed: () =>
        Effect.sync(() =>
          [...keyed].map((key) => ({
            jobId: makeJobId(),
            queue: ISSUE_POLL_QUEUE,
            key,
            payload: { _tag: "refresh-repository" as const, repositoryId: key },
            attempts: 0,
            maxAttempts: 2,
            availableAt: DateTime.makeUnsafe(0),
            lockedUntil: null,
          })),
        ),
      removeKeyed: (_queue, key) =>
        Effect.sync(() => {
          removed.push(key)
          keyed.delete(key)
        }),
    })

    try {
      await runtime.runPromise(
        repairPollingSchedules({
          credentialedRepositoryIds: [repoKeep, repoAdded],
          sampleDelay: Effect.succeed(Duration.seconds(120)),
        }),
      )

      expect(removed).toEqual([repoOrphan])
      expect(ensured).toEqual([repoAdded])
      expect(enqueued).toEqual([repoAdded])
      expect([...keyed].sort()).toEqual([repoKeep, repoAdded].sort())
    } finally {
      await runtime.dispose()
    }
  })
})
