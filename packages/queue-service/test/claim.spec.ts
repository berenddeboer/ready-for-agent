import { DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import {
  JobId,
  PayloadParseError,
  QueueService,
  type RawJob,
} from "../src/index.js"
import type { QueueServiceShape } from "../src/lib/queue-service.js"
import { stubQueueService } from "../src/lib/test-fixtures.js"
import { describe, expect, it } from "bun:test"

const TestPayload = Schema.Struct({
  task: Schema.String,
})

const sampleJobId = JobId.make("qjob-01ARZ3NDEKTSV4RRFFQ69G5FAV")

const makeRawJob = (payload: unknown): RawJob => ({
  jobId: sampleJobId,
  queue: "test-queue",
  key: null,
  payload,
  attempts: 1,
  maxAttempts: 5,
  availableAt: DateTime.makeUnsafe(0),
  lockedUntil: DateTime.makeUnsafe(30_000),
})

const makeFakeQueue = (
  rawClaim: QueueServiceShape["rawClaim"],
): QueueServiceShape =>
  stubQueueService({
    queueInTransaction: false,
    rawClaim,
  })

const runWithQueue = <A, E>(
  queue: QueueServiceShape,
  effect: Effect.Effect<A, E, QueueService>,
) =>
  Effect.runPromise(
    Effect.provide(effect, Layer.succeed(QueueService, QueueService.of(queue))),
  )

describe("stubQueueService", () => {
  it("identifies unexpected operation calls", async () => {
    await expect(
      Effect.runPromise(stubQueueService().enqueue("test-queue", {})),
    ).rejects.toThrow("Unexpected QueueService.enqueue call")
  })
})

describe("QueueService.claim", () => {
  it("returns None when rawClaim returns None", async () => {
    const result = await runWithQueue(
      makeFakeQueue(() => Effect.succeed(Option.none())),
      QueueService.claim("test-queue", TestPayload),
    )
    expect(Option.isNone(result)).toBe(true)
  })

  it("decodes a valid payload into a typed Job", async () => {
    const result = await runWithQueue(
      makeFakeQueue(() =>
        Effect.succeed(Option.some(makeRawJob({ task: "hello" }))),
      ),
      QueueService.claim("test-queue", TestPayload, Duration.seconds(10)),
    )
    expect(Option.isSome(result)).toBe(true)
    if (Option.isSome(result)) {
      expect(result.value.jobId).toBe(sampleJobId)
      expect(result.value.queue).toBe("test-queue")
      expect(result.value.payload).toEqual({ task: "hello" })
      expect(result.value.attempts).toBe(1)
      expect(result.value.maxAttempts).toBe(5)
    }
  })

  it("fails with PayloadParseError when payload does not match schema", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.provide(
          QueueService.claim("test-queue", TestPayload),
          Layer.succeed(
            QueueService,
            QueueService.of(
              makeFakeQueue(() =>
                Effect.succeed(Option.some(makeRawJob({ notTask: 1 }))),
              ),
            ),
          ),
        ),
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(PayloadParseError)
      expect(result.failure.queue).toBe("test-queue")
      expect(result.failure.jobId).toBe(sampleJobId)
    }
  })
})
