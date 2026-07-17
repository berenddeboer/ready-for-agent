import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { Opencode } from "@ready-for-agent/opencode"
import { limitOpencodeSessions } from "../src/lib/opencode-session-limiter.js"
import { describe, expect, it } from "bun:test"

const TestLayer = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))

const runTest = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<typeof TestLayer>>,
) => Effect.runPromise(Effect.provide(effect, TestLayer))

const startInput = {
  prompt: "implement",
  cwd: "/tmp/worktree",
  model: "test/model",
  variant: "low",
}

describe("limitOpencodeSessions", () => {
  it("caps concurrent start/continue to Config max and queues the rest", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        yield* db.updateConfig({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultVariant: "low",
          reviewModel: null,
          reviewVariant: null,
          maxConcurrentOpencodeSessions: 2,
        })

        const release = yield* Deferred.make<void>()
        const twoRunning = yield* Deferred.make<void>()
        const started = yield* Ref.make(0)
        const maximumActive = yield* Ref.make(0)
        const active = yield* Ref.make(0)

        const gatedRun = () =>
          Effect.gen(function* () {
            yield* Ref.update(active, (n) => n + 1)
            const current = yield* Ref.get(active)
            yield* Ref.update(maximumActive, (max) => Math.max(max, current))
            const count = yield* Ref.updateAndGet(started, (n) => n + 1)
            if (count === 2) {
              yield* Deferred.succeed(twoRunning, undefined)
            }
            yield* Deferred.await(release)
            yield* Ref.update(active, (n) => n - 1)
            return { sessionId: "ses_test", assistantText: "" }
          })

        const inner = Opencode.of({
          start: () => gatedRun(),
          continue: () => gatedRun(),
          listModels: () => Effect.succeed([]),
        })
        const limited = yield* limitOpencodeSessions(inner, db)

        const first = yield* limited.start(startInput).pipe(Effect.forkChild)
        const second = yield* limited.start(startInput).pipe(Effect.forkChild)
        const third = yield* limited
          .continue({
            ...startInput,
            sessionId: "ses_existing",
          })
          .pipe(Effect.forkChild)

        yield* Deferred.await(twoRunning)
        expect(yield* Ref.get(started)).toBe(2)
        expect(yield* Ref.get(maximumActive)).toBe(2)
        expect(yield* Ref.get(active)).toBe(2)

        yield* Effect.sleep("50 millis")
        expect(yield* Ref.get(started)).toBe(2)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        yield* Fiber.join(third)

        expect(yield* Ref.get(started)).toBe(3)
        expect(yield* Ref.get(maximumActive)).toBe(2)
        expect(yield* Ref.get(active)).toBe(0)
      }),
    ))

  it("does not count listModels toward the OpenCode session limit", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        yield* db.updateConfig({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultVariant: "low",
          reviewModel: null,
          reviewVariant: null,
          maxConcurrentOpencodeSessions: 1,
        })

        const releaseStart = yield* Deferred.make<void>()
        const listModelsStarted = yield* Deferred.make<void>()
        let startActive = false
        let listModelsWhileStartActive = false

        const inner = Opencode.of({
          start: () =>
            Effect.gen(function* () {
              startActive = true
              yield* Deferred.await(releaseStart)
              startActive = false
              return { sessionId: "ses_test", assistantText: "" }
            }),
          continue: () =>
            Effect.succeed({ sessionId: "ses_test", assistantText: "" }),
          listModels: () =>
            Effect.gen(function* () {
              listModelsWhileStartActive = startActive
              yield* Deferred.succeed(listModelsStarted, undefined)
              return ["model-a"]
            }),
        })
        const limited = yield* limitOpencodeSessions(inner, db)

        const startFiber = yield* limited
          .start(startInput)
          .pipe(Effect.forkChild)
        yield* Effect.sleep("20 millis")
        const models = yield* limited.listModels({ cwd: "/tmp" })
        yield* Deferred.await(listModelsStarted)
        yield* Deferred.succeed(releaseStart, undefined)
        yield* Fiber.join(startFiber)

        expect(models).toEqual(["model-a"])
        expect(listModelsWhileStartActive).toBe(true)
      }),
    ))

  it("admits a waiter when Config max is raised while a run is in flight", () =>
    runTest(
      Effect.gen(function* () {
        const db = yield* DbService
        yield* db.updateConfig({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultVariant: "low",
          reviewModel: null,
          reviewVariant: null,
          maxConcurrentOpencodeSessions: 1,
        })

        const releaseFirst = yield* Deferred.make<void>()
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        let starts = 0

        const inner = Opencode.of({
          start: () =>
            Effect.gen(function* () {
              starts += 1
              if (starts === 1) {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(releaseFirst)
              } else {
                yield* Deferred.succeed(secondStarted, undefined)
              }
              return { sessionId: `ses_${starts}`, assistantText: "" }
            }),
          continue: () =>
            Effect.succeed({ sessionId: "ses_x", assistantText: "" }),
          listModels: () => Effect.succeed([]),
        })
        const limited = yield* limitOpencodeSessions(inner, db)

        const first = yield* limited.start(startInput).pipe(Effect.forkChild)
        yield* Deferred.await(firstStarted)

        const second = yield* limited.start(startInput).pipe(Effect.forkChild)
        yield* Effect.sleep("50 millis")
        expect(starts).toBe(1)

        yield* db.updateConfig({
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultVariant: "low",
          reviewModel: null,
          reviewVariant: null,
          maxConcurrentOpencodeSessions: 2,
        })
        yield* Deferred.await(secondStarted)
        expect(starts).toBe(2)

        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
    ))
})
