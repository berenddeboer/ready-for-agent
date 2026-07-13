import { Effect } from "effect"
import { InvalidQueueNameError, validateQueueName } from "../src/index.js"
import { describe, expect, it } from "bun:test"

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
    const result = await Effect.runPromise(Effect.either(validateQueueName("")))

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(InvalidQueueNameError)
      expect(result.left.message).toContain("cannot be empty")
      expect(result.left.message).toContain("minimum length is 1 character")
      expect(result.left.queueName).toBe("")
    }
  })

  it("should fail for queue name exceeding max length", async () => {
    const longName = "a".repeat(81)
    const result = await Effect.runPromise(
      Effect.either(validateQueueName(longName)),
    )

    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(InvalidQueueNameError)
      expect(result.left.message).toContain("exceeds maximum length")
      expect(result.left.message).toContain("80 characters")
      expect(result.left.message).toContain("81")
      expect(result.left.queueName).toBe(longName)
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
      const result = await Effect.runPromise(
        Effect.either(validateQueueName(name)),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(InvalidQueueNameError)
        expect(result.left.message).toContain("invalid characters")
        expect(result.left.message).toContain("Spaces are NOT allowed")
        expect(result.left.queueName).toBe(name)
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
      const result = await Effect.runPromise(
        Effect.either(validateQueueName(name)),
      )

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(InvalidQueueNameError)
        expect(result.left.message).toContain("invalid characters")
        expect(result.left.queueName).toBe(name)
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
