import { Duration, Effect, Layer, Option } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  InvalidQueueNameError,
  QueueService,
} from "@ready-for-agent/queue-service"
import { SqliteQueueServiceLive } from "../src/lib/sqlite-queue-service.js"
import { describe, expect, it } from "bun:test"

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

          expect(jobId).toBeDefined()
          expect(typeof jobId).toBe("string")
          expect(jobId.length).toBeGreaterThan(0)
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

          expect(jobId).toBeDefined()

          const job = yield* queue.rawClaim("delayed-queue")
          expect(Option.isNone(job)).toBe(true)
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
