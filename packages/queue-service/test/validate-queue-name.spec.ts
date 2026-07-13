import { Effect } from "effect"
import { InvalidQueueNameError, validateQueueName } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const runValidation = (queueName: string) =>
  Effect.runPromise(
    validateQueueName(queueName).pipe(
      Effect.match({
        onFailure: (error) => ({ _tag: "Failure" as const, error }),
        onSuccess: () => ({ _tag: "Success" as const }),
      }),
    ),
  )

describe("validateQueueName", () => {
  it("should succeed for valid queue names", async () => {
    const validNames = [
      "test-queue",
      "Queue.Name_123",
      "a",
      "A",
      "0",
      "test_queue",
      "test.queue",
      "test-queue",
      "MixedCase123",
      "a".repeat(80),
    ]

    for (const name of validNames) {
      const result = await Effect.runPromise(validateQueueName(name))
      expect(result).toBe(name)
    }
  })

  it("should fail for empty queue name", async () => {
    const result = await runValidation("")

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.error).toBeInstanceOf(InvalidQueueNameError)
      expect(result.error.message).toContain("cannot be empty")
      expect(result.error.message).toContain("minimum length is 1 character")
      expect(result.error.queueName).toBe("")
    }
  })

  it("should fail for queue name exceeding max length", async () => {
    const longName = "a".repeat(81)
    const result = await runValidation(longName)

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.error).toBeInstanceOf(InvalidQueueNameError)
      expect(result.error.message).toContain("exceeds maximum length")
      expect(result.error.message).toContain("80 characters")
      expect(result.error.message).toContain("81")
      expect(result.error.queueName).toBe(longName)
    }
  })

  it("should fail for queue names with spaces", async () => {
    const invalidNames = [
      "test queue",
      " test",
      "test ",
      " test ",
      "test queue name",
    ]

    for (const name of invalidNames) {
      const result = await runValidation(name)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.error).toBeInstanceOf(InvalidQueueNameError)
        expect(result.error.message).toContain("invalid characters")
        expect(result.error.message).toContain("Spaces are NOT allowed")
        expect(result.error.queueName).toBe(name)
      }
    }
  })

  it("should fail for queue names with special characters", async () => {
    const invalidNames = [
      "test@queue",
      "queue!",
      "test#queue",
      "queue/name",
      "test$queue",
      "queue%name",
      "test^queue",
      "queue&name",
      "test*queue",
      "queue+name",
      "test=queue",
      "queue[name]",
      "test{queue}",
      "queue|name",
      "test\\queue",
      "queue:name",
      "test;queue",
      'queue"name',
      "test'queue",
      "queue<name>",
      "test,queue",
      "queue?name",
    ]

    for (const name of invalidNames) {
      const result = await runValidation(name)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.error).toBeInstanceOf(InvalidQueueNameError)
        expect(result.error.message).toContain("invalid characters")
        expect(result.error.queueName).toBe(name)
      }
    }
  })

  it("should allow hyphens, underscores, and periods", async () => {
    const validNames = [
      "test-queue",
      "test_queue",
      "test.queue",
      "test-_.",
      ".-_test",
      "my-queue_name.v2",
    ]

    for (const name of validNames) {
      const result = await Effect.runPromise(validateQueueName(name))
      expect(result).toBe(name)
    }
  })

  it("should allow all alphanumeric characters", async () => {
    const validNames = [
      "abcdefghijklmnopqrstuvwxyz",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "0123456789",
      "aA0",
    ]

    for (const name of validNames) {
      const result = await Effect.runPromise(validateQueueName(name))
      expect(result).toBe(name)
    }
  })
})
