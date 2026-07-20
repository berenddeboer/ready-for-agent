import { DateTime, Duration, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  ClaimError,
  InvalidQueueNameError,
  QueueService,
} from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "../src/lib/sqlite-queue-service.js"
import { describe, expect, it } from "bun:test"

const JOB_ID_PATTERN = /^qjob-[0-9A-HJKMNP-TV-Z]{26}$/

describe("SqliteQueueService", () => {
  const TestLayer = SqliteQueueServiceLive.pipe(
    Layer.provideMerge(DatabaseTest),
  )

  type TestRequirements = Layer.Layer.Success<typeof TestLayer>

  const runTest = <A, E>(
    test: Effect.Effect<A, E, TestRequirements>,
  ): Promise<A> => {
    return Effect.runPromise(Effect.provide(test, TestLayer))
  }

  describe("enqueue", () => {
    it("should enqueue a job and return job ID", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const jobId = yield* queue.enqueue("test-queue", { task: "test" })

          expect(jobId).toMatch(JOB_ID_PATTERN)
        }),
      ))

    it("should enqueue jobs with different payloads", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const jobId1 = yield* queue.enqueue("test-queue", { task: "task1" })
          const jobId2 = yield* queue.enqueue("test-queue", { task: "task2" })

          expect(jobId1).not.toBe(jobId2)
        }),
      ))

    it("should enqueue and claim a job", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("retry-queue", { task: "test" })

          const job = yield* queue.rawClaim("retry-queue")
          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            expect(job.value.attempts).toBe(1)
          }
        }),
      ))
  })

  describe("enqueueWithDelay", () => {
    it("should enqueue a job with delay", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const jobId = yield* queue.enqueueWithDelay(
            "delayed-queue",
            { task: "delayed" },
            Duration.seconds(60),
          )

          expect(jobId).toMatch(JOB_ID_PATTERN)

          const job = yield* queue.rawClaim("delayed-queue")
          expect(Option.isNone(job)).toBe(true)
        }),
      ))

    it("should preserve a delayed job ID when claimed", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const jobId = yield* queue.enqueueWithDelay(
            "delayed-round-trip-queue",
            { task: "delayed" },
            Duration.zero,
          )

          expect(jobId).toMatch(JOB_ID_PATTERN)

          const job = yield* queue.rawClaim("delayed-round-trip-queue")
          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            expect(job.value.jobId).toBe(jobId)
          }
        }),
      ))
  })

  describe("claim", () => {
    it("should claim an available job", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const jobId = yield* queue.enqueue("claim-queue", {
            task: "to-claim",
          })
          expect(jobId).toMatch(JOB_ID_PATTERN)
          const job = yield* queue.rawClaim("claim-queue")

          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            expect(job.value.jobId).toBe(jobId)
            expect(job.value.payload).toEqual({ task: "to-claim" })
            expect(job.value.attempts).toBe(1)
          }
        }),
      ))

    it("should return None when no jobs available", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const job = yield* queue.rawClaim("empty-queue")

          expect(Option.isNone(job)).toBe(true)
        }),
      ))

    it("should not claim already claimed job", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("single-claim-queue", { task: "test" })

          const job1 = yield* queue.rawClaim("single-claim-queue")
          const job2 = yield* queue.rawClaim("single-claim-queue")

          expect(Option.isSome(job1)).toBe(true)
          expect(Option.isNone(job2)).toBe(true)
        }),
      ))

    it("should increment attempts on each claim", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("attempts-queue", { task: "test" })

          const job1 = yield* queue.rawClaim(
            "attempts-queue",
            Duration.millis(1),
          )
          expect(Option.isSome(job1)).toBe(true)
          if (Option.isSome(job1)) {
            expect(job1.value.attempts).toBe(1)
          }

          yield* Effect.sleep(Duration.millis(10))

          const job2 = yield* queue.rawClaim(
            "attempts-queue",
            Duration.millis(1),
          )
          expect(Option.isSome(job2)).toBe(true)
          if (Option.isSome(job2)) {
            expect(job2.value.attempts).toBe(2)
          }
        }),
      ))

    it("should prefer fresh jobs over retried jobs", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `retry-order-queue-${Date.now()}`

          yield* queue.enqueue(queueName, { task: "retried" })

          const firstClaim = yield* queue.rawClaim(
            queueName,
            Duration.seconds(60),
          )
          expect(Option.isSome(firstClaim)).toBe(true)
          if (Option.isSome(firstClaim)) {
            yield* queue.fail(firstClaim.value.jobId, {
              releaseImmediately: true,
            })
          }

          yield* queue.enqueue(queueName, { task: "fresh" })

          const nextClaim = yield* queue.rawClaim(
            queueName,
            Duration.seconds(60),
          )
          expect(Option.isSome(nextClaim)).toBe(true)
          if (Option.isSome(nextClaim)) {
            expect(nextClaim.value.payload).toEqual({ task: "fresh" })
            expect(nextClaim.value.attempts).toBe(1)
          }
        }),
      ))

    it("should not claim jobs that exceeded max retries", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `max-retry-queue-${Date.now()}`

          yield* queue.enqueue(queueName, { task: "test" })

          for (let i = 0; i < 5; i++) {
            const job = yield* queue.rawClaim(queueName, Duration.millis(1))
            expect(Option.isSome(job)).toBe(true)
            yield* Effect.sleep(Duration.millis(10))
          }

          const job6 = yield* queue.rawClaim(queueName)
          expect(Option.isNone(job6)).toBe(true)
        }),
      ))

    it("should fail with ClaimError when job payload is corrupt JSON", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const sql = yield* SqlClient.SqlClient
          const queueName = `corrupt-payload-queue-${Date.now()}`
          const now = Date.now()
          yield* sql.unsafe(
            `INSERT INTO job_queue (id, queue, job_payload, job_retry_limit, available_at, locked_until, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
            [
              "qjob-01ARZ3NDEKTSV4RRFFQ69G5FAV",
              queueName,
              "{not-json",
              5,
              now,
              now,
              now,
            ],
          )

          const result = yield* Effect.result(queue.rawClaim(queueName))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(ClaimError)
            expect(result.failure.message).toContain(
              "Failed to parse job payload",
            )
          }
        }),
      ))
  })

  describe("acknowledge", () => {
    it("should acknowledge and remove job from queue", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const jobId = yield* queue.enqueue("ack-queue", { task: "test" })
          yield* queue.rawClaim("ack-queue")
          yield* queue.acknowledge(jobId)

          const job = yield* queue.rawClaim("ack-queue")
          expect(Option.isNone(job)).toBe(true)
        }),
      ))

    it("should fail for non-existent job", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const result = yield* Effect.result(
            queue.acknowledge("non-existent-id"),
          )

          expect(result._tag).toBe("Failure")
        }),
      ))
  })

  describe("fail", () => {
    it("should mark job as failed but keep it for retry", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("fail-queue", { task: "test" })
          const job = yield* queue.rawClaim("fail-queue", Duration.seconds(60))

          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            yield* queue.fail(job.value.jobId)

            const job2 = yield* queue.rawClaim("fail-queue")
            expect(Option.isNone(job2)).toBe(true)
          }
        }),
      ))

    it("should release job immediately with releaseImmediately option", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("fail-immediate-queue", { task: "test" })
          const job = yield* queue.rawClaim(
            "fail-immediate-queue",
            Duration.seconds(60),
          )

          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            yield* queue.fail(job.value.jobId, { releaseImmediately: true })

            const job2 = yield* queue.rawClaim("fail-immediate-queue")
            expect(Option.isSome(job2)).toBe(true)
            if (Option.isSome(job2)) {
              expect(job2.value.attempts).toBe(2)
            }
          }
        }),
      ))
  })

  describe("extendVisibility", () => {
    it("should set new visibility timeout from now", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          yield* queue.enqueue("extend-queue", { task: "test" })
          const job = yield* queue.rawClaim("extend-queue", Duration.millis(50))

          expect(Option.isSome(job)).toBe(true)
          if (Option.isSome(job)) {
            yield* queue.extendVisibility(job.value.jobId, Duration.seconds(10))

            yield* Effect.sleep(Duration.millis(60))

            const job2 = yield* queue.rawClaim("extend-queue")
            expect(Option.isNone(job2)).toBe(true)
          }
        }),
      ))

    it("should fail for non-existent job", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService

          const result = yield* Effect.result(
            queue.extendVisibility("non-existent-id", Duration.seconds(10)),
          )

          expect(result._tag).toBe("Failure")
        }),
      ))
  })

  describe("getStats", () => {
    it("should return queue statistics", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `stats-queue-${Date.now()}`

          yield* queue.enqueue(queueName, { task: "pending1" })
          yield* queue.enqueue(queueName, { task: "pending2" })

          const claimed = yield* queue.rawClaim(queueName, Duration.seconds(60))
          expect(Option.isSome(claimed)).toBe(true)

          const stats = yield* queue.getStats(queueName)

          expect(stats.processing).toBe(1)
          expect(stats.pending).toBe(1)
          expect(stats.deadLetter).toBe(0)
        }),
      ))

    it("should count dead letter jobs", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = `dead-letter-queue-${Date.now()}`

          yield* queue.enqueue(queueName, { task: "test" })

          for (let i = 0; i < 5; i++) {
            yield* queue.rawClaim(queueName, Duration.millis(1))
            yield* Effect.sleep(Duration.millis(10))
          }

          const stats = yield* queue.getStats(queueName)

          expect(stats.deadLetter).toBe(1)
        }),
      ))
  })

  describe("concurrency", () => {
    it("should handle concurrent enqueue operations", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = "concurrent-enqueue-queue"

          const jobIds = yield* Effect.all(
            Array.from({ length: 10 }, (_, i) =>
              queue.enqueue(queueName, { task: `task-${i}` }),
            ),
            { concurrency: 10 },
          )

          const uniqueIds = new Set(jobIds)
          expect(uniqueIds.size).toBe(10)

          const jobs: string[] = []
          for (let i = 0; i < 10; i++) {
            const job = yield* queue.rawClaim(queueName, Duration.millis(1))
            if (Option.isSome(job)) {
              jobs.push(job.value.jobId)
            }
            yield* Effect.sleep(Duration.millis(5))
          }
          expect(jobs.length).toBe(10)
        }),
      ))

    it("should not double-claim jobs under concurrent claim attempts", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const queueName = "concurrent-claim-queue"

          for (let i = 0; i < 5; i++) {
            yield* queue.enqueue(queueName, { task: `task-${i}` })
          }

          const results = yield* Effect.all(
            Array.from({ length: 10 }, () =>
              queue.rawClaim(queueName, Duration.seconds(60)),
            ),
            { concurrency: 10 },
          )

          const successfulClaims = results.filter(Option.isSome)
          expect(successfulClaims.length).toBe(5)

          const claimedIds = successfulClaims.map((job) => job.value.jobId)
          const uniqueClaimedIds = new Set(claimedIds)
          expect(uniqueClaimedIds.size).toBe(5)
        }),
      ))
  })

  describe("keyed recurring entries", () => {
    it("enforces uniqueness for non-null (queue, key) pairs", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const first = yield* queue.ensureKeyed(
            "keyed-queue",
            "repo-1",
            { kind: "poll" },
            Duration.seconds(120),
          )
          expect(first.created).toBe(true)

          const second = yield* queue.ensureKeyed(
            "keyed-queue",
            "repo-1",
            { kind: "poll-updated" },
            Duration.seconds(30),
          )
          expect(second.created).toBe(false)
          expect(second.jobId).toBe(first.jobId)

          const entries = yield* queue.listKeyed("keyed-queue")
          expect(entries).toHaveLength(1)
          expect(entries[0]!.key).toBe("repo-1")
          expect(entries[0]!.payload).toEqual({ kind: "poll" })
        }),
      ))

    it("revives an exhausted keyed entry", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const first = yield* queue.ensureKeyed(
            "revive-keyed-queue",
            "polling-auto-heal",
            { kind: "poll" },
            Duration.zero,
            { retryLimit: 0 },
          )
          expect(
            Option.isSome(yield* queue.rawClaim("revive-keyed-queue")),
          ).toBe(true)

          yield* queue.reviveExhaustedKeyed("revive-keyed-queue")

          const reclaimed = yield* queue.rawClaim("revive-keyed-queue")
          expect(Option.isSome(reclaimed)).toBe(true)
          if (Option.isSome(reclaimed)) {
            expect(reclaimed.value.jobId).toBe(first.jobId)
            expect(reclaimed.value.attempts).toBe(1)
          }
        }),
      ))

    it("does not revive an actively claimed final attempt by default", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const first = yield* queue.ensureKeyed(
            "active-keyed-queue",
            "repo-1",
            { kind: "poll" },
            Duration.zero,
            { retryLimit: 0 },
          )
          const claimed = yield* queue.rawClaim(
            "active-keyed-queue",
            Duration.minutes(5),
          )
          expect(Option.isSome(claimed)).toBe(true)

          const ensured = yield* queue.ensureKeyed(
            "active-keyed-queue",
            "repo-1",
            { kind: "poll" },
            Duration.zero,
            { retryLimit: 0 },
          )
          expect(ensured).toEqual({ jobId: first.jobId, created: false })
          expect(
            Option.isNone(yield* queue.rawClaim("active-keyed-queue")),
          ).toBe(true)

          const entries = yield* queue.listKeyed("active-keyed-queue")
          expect(entries[0]?.attempts).toBe(1)
          expect(entries[0]?.lockedUntil).not.toBeNull()
        }),
      ))

    it("allows the same key in different queues", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const a = yield* queue.ensureKeyed(
            "queue-a",
            "shared-key",
            { q: "a" },
            Duration.zero,
          )
          const b = yield* queue.ensureKeyed(
            "queue-b",
            "shared-key",
            { q: "b" },
            Duration.zero,
          )
          expect(a.created).toBe(true)
          expect(b.created).toBe(true)
          expect(a.jobId).not.toBe(b.jobId)
        }),
      ))

    it("allows multiple unkeyed jobs with identical payloads", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const payload = { task: "same" }
          const id1 = yield* queue.enqueue("unkeyed-queue", payload)
          const id2 = yield* queue.enqueue("unkeyed-queue", payload)
          expect(id1).not.toBe(id2)

          const first = yield* queue.rawClaim("unkeyed-queue")
          const second = yield* queue.rawClaim("unkeyed-queue")
          expect(Option.isSome(first)).toBe(true)
          expect(Option.isSome(second)).toBe(true)
          if (Option.isSome(first) && Option.isSome(second)) {
            expect(first.value.key).toBeNull()
            expect(second.value.key).toBeNull()
            expect(first.value.payload).toEqual(payload)
            expect(second.value.payload).toEqual(payload)
          }
        }),
      ))

    it("produces one durable entry under concurrent ensure", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const results = yield* Effect.all(
            Array.from({ length: 20 }, () =>
              queue.ensureKeyed(
                "concurrent-ensure",
                "only-one",
                { n: 1 },
                Duration.seconds(60),
              ),
            ),
            { concurrency: 20 },
          )

          const created = results.filter((r) => r.created)
          expect(created).toHaveLength(1)
          expect(new Set(results.map((r) => r.jobId)).size).toBe(1)

          const entries = yield* queue.listKeyed("concurrent-ensure")
          expect(entries).toHaveLength(1)
          expect(entries[0]!.jobId).toBe(created[0]!.jobId)
        }),
      ))

    it("lists keyed entries for a queue without unkeyed jobs", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          yield* queue.enqueue("inspect-queue", { one: "shot" })
          yield* queue.ensureKeyed(
            "inspect-queue",
            "k1",
            { recurring: true },
            Duration.seconds(10),
          )
          yield* queue.ensureKeyed(
            "inspect-queue",
            "k2",
            { recurring: true },
            Duration.seconds(20),
          )
          yield* queue.ensureKeyed(
            "other-queue",
            "k1",
            { other: true },
            Duration.zero,
          )

          const entries = yield* queue.listKeyed("inspect-queue")
          expect(entries.map((e) => e.key).sort()).toEqual(["k1", "k2"])
          expect(entries.every((e) => e.queue === "inspect-queue")).toBe(true)
        }),
      ))

    it("postpones a claimed keyed entry in place", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const ensured = yield* queue.ensureKeyed(
            "postpone-queue",
            "repo-x",
            { kind: "poll" },
            Duration.zero,
          )
          expect(ensured.created).toBe(true)

          const claimed = yield* queue.rawClaim("postpone-queue")
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isNone(claimed)) return
          expect(claimed.value.jobId).toBe(ensured.jobId)
          expect(claimed.value.key).toBe("repo-x")
          expect(claimed.value.attempts).toBe(1)

          yield* queue.postponeKeyed(claimed.value.jobId, Duration.seconds(120))

          const immediately = yield* queue.rawClaim("postpone-queue")
          expect(Option.isNone(immediately)).toBe(true)

          const entries = yield* queue.listKeyed("postpone-queue")
          expect(entries).toHaveLength(1)
          expect(entries[0]!.jobId).toBe(ensured.jobId)
          expect(entries[0]!.key).toBe("repo-x")
          expect(entries[0]!.attempts).toBe(0)
          expect(entries[0]!.lockedUntil).toBeNull()

          const availableAtMs = DateTime.toEpochMillis(entries[0]!.availableAt)
          const now = Date.now()
          expect(availableAtMs).toBeGreaterThan(now + 100_000)
          expect(availableAtMs).toBeLessThanOrEqual(now + 125_000)
        }),
      ))

    it("makes a postponed entry claimable after its delay elapses", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const ensured = yield* queue.ensureKeyed(
            "delay-claim-queue",
            "repo-y",
            { kind: "poll" },
            Duration.zero,
          )
          const claimed = yield* queue.rawClaim("delay-claim-queue")
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isNone(claimed)) return

          yield* queue.postponeKeyed(claimed.value.jobId, Duration.millis(30))
          yield* Effect.sleep(Duration.millis(50))

          const reclaimed = yield* queue.rawClaim("delay-claim-queue")
          expect(Option.isSome(reclaimed)).toBe(true)
          if (Option.isSome(reclaimed)) {
            expect(reclaimed.value.jobId).toBe(ensured.jobId)
            expect(reclaimed.value.key).toBe("repo-y")
            expect(reclaimed.value.attempts).toBe(1)
          }
        }),
      ))

    it("removes a keyed entry idempotently and queue-scoped", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          yield* queue.ensureKeyed(
            "remove-queue",
            "to-remove",
            { x: 1 },
            Duration.zero,
          )
          yield* queue.ensureKeyed(
            "remove-queue-other",
            "to-remove",
            { x: 2 },
            Duration.zero,
          )

          yield* queue.removeKeyed("remove-queue", "to-remove")
          expect(yield* queue.listKeyed("remove-queue")).toEqual([])
          expect(yield* queue.listKeyed("remove-queue-other")).toHaveLength(1)

          yield* queue.removeKeyed("remove-queue", "to-remove")
          expect(yield* queue.listKeyed("remove-queue")).toEqual([])
        }),
      ))

    it("preserves existing unkeyed rows after keyed schema migration", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const jobId = yield* queue.enqueue("migration-compat", {
            legacy: true,
          })
          const claimed = yield* queue.rawClaim("migration-compat")
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isSome(claimed)) {
            expect(claimed.value.jobId).toBe(jobId)
            expect(claimed.value.key).toBeNull()
            expect(claimed.value.payload).toEqual({ legacy: true })
          }
          yield* queue.acknowledge(jobId)
        }),
      ))

    it("leaves one-shot delayed enqueue behavior unchanged", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const jobId = yield* queue.enqueueWithDelay(
            "one-shot-delay",
            { task: "later" },
            Duration.seconds(60),
          )
          expect(Option.isNone(yield* queue.rawClaim("one-shot-delay"))).toBe(
            true,
          )
          expect(yield* queue.listKeyed("one-shot-delay")).toEqual([])

          const zeroDelayId = yield* queue.enqueueWithDelay(
            "one-shot-delay",
            { task: "now" },
            Duration.zero,
          )
          const claimed = yield* queue.rawClaim("one-shot-delay")
          expect(Option.isSome(claimed)).toBe(true)
          if (Option.isSome(claimed)) {
            expect(claimed.value.jobId).toBe(zeroDelayId)
            expect(claimed.value.key).toBeNull()
          }
          expect(jobId).not.toBe(zeroDelayId)
        }),
      ))

    it("moves jobs by payload tag between queues without duplication", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const refreshId = yield* queue.enqueue("from-queue", {
            _tag: "refresh-repository",
            repositoryId: "repo-1",
          })
          const otherId = yield* queue.enqueue("from-queue", {
            _tag: "work-item-step",
            stepRunId: "srun-1",
          })

          const moved = yield* queue.requeueByPayloadTag(
            "from-queue",
            "to-queue",
            "refresh-repository",
          )
          expect(moved).toBe(1)
          expect(
            yield* queue.requeueByPayloadTag(
              "from-queue",
              "to-queue",
              "refresh-repository",
            ),
          ).toBe(0)

          const remaining = yield* queue.rawClaim("from-queue")
          expect(Option.isSome(remaining)).toBe(true)
          if (Option.isSome(remaining)) {
            expect(remaining.value.jobId).toBe(otherId)
          }

          const transferred = yield* queue.rawClaim("to-queue")
          expect(Option.isSome(transferred)).toBe(true)
          if (Option.isSome(transferred)) {
            expect(transferred.value.jobId).toBe(refreshId)
            expect(transferred.value.payload).toEqual({
              _tag: "refresh-repository",
              repositoryId: "repo-1",
            })
          }
        }),
      ))
  })

  describe("queue name validation", () => {
    it("should reject enqueue with invalid queue name (spaces)", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(
            queue.enqueue("invalid queue", { task: "test" }),
          )

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
            expect(result.failure.message).toContain("invalid characters")
          }
        }),
      ))

    it("should reject enqueue with invalid queue name (special chars)", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(
            queue.enqueue("invalid@queue", { task: "test" }),
          )

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))

    it("should reject enqueue with empty queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(
            queue.enqueue("", { task: "test" }),
          )

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
            expect(result.failure.message).toContain("cannot be empty")
          }
        }),
      ))

    it("should reject enqueue with queue name exceeding max length", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const longName = "a".repeat(81)
          const result = yield* Effect.result(
            queue.enqueue(longName, { task: "test" }),
          )

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
            expect(result.failure.message).toContain("exceeds maximum length")
          }
        }),
      ))

    it("should reject enqueueWithDelay with invalid queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(
            queue.enqueueWithDelay(
              "invalid queue",
              { task: "test" },
              Duration.seconds(1),
            ),
          )

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))

    it("should reject claim with invalid queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(queue.rawClaim("invalid@queue"))

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))

    it("should accept valid queue names", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const validNames = [
            "test-queue",
            "test_queue",
            "test.queue",
            "TestQueue123",
            "a",
          ]

          for (const name of validNames) {
            const jobId = yield* queue.enqueue(name, { task: "test" })
            expect(jobId).toBeDefined()
          }
        }),
      ))

    it("should reject getStats with invalid queue name", () =>
      runTest(
        Effect.gen(function* () {
          const queue = yield* QueueService
          const result = yield* Effect.result(queue.getStats("invalid queue"))

          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(InvalidQueueNameError)
          }
        }),
      ))
  })
})
