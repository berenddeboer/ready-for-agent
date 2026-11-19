import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { AgentBackendStartupTimeoutError } from "@ready-for-agent/agent-backend"
import { runStoppablePlainPrompt } from "../src/lib/plain-prompt-stop.js"
import { expect, it } from "bun:test"

it("interrupts after assistant messages push the Implement prompt off the unfiltered page", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const launched = yield* Deferred.make<void>()
      const prompt = "Implement"
      const history = [
        ...Array.from({ length: 21 }, (_, i) => ({
          id: `msg_assistant_${i}`,
          type: "assistant",
        })),
        { id: "msg_submit", type: "user", text: prompt },
      ]
      const calls: string[] = []
      let confirmed = false
      const turn = yield* runStoppablePlainPrompt({
        target: { sessionId: "ses_long", serverKey: "fixture" },
        resumed: false,
        prompt,
        run: Deferred.succeed(launched, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
        capture: (args) =>
          Effect.sync(() => {
            const path = args[2] ?? ""
            if (path.includes("/message?")) {
              const { searchParams } = new URL(path, "http://fixture")
              const type = searchParams.get("type")
              const matching =
                type === null
                  ? history
                  : history.filter((entry) => entry.type === type)
              const data = matching.slice(0, Number(searchParams.get("limit")))
              return { stdout: JSON.stringify({ data }) }
            }
            calls.push(path)
            return {
              stdout: path.endsWith("/interrupt") ? '{"interrupted":true}' : "",
            }
          }),
        track: {
          started: () => Effect.void,
          stopped: () =>
            Effect.sync(() => {
              confirmed = true
            }),
        },
        verifyIdle: Effect.die("The original turn is still active"),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(launched)
      const reset = yield* Fiber.interrupt(turn).pipe(Effect.forkChild)
      yield* TestClock.adjust("11 seconds")
      yield* Fiber.join(reset)
      expect(calls).toEqual([
        "/api/session/ses_long/interrupt",
        "/api/experimental/session/ses_long/wait",
      ])
      expect(confirmed).toBe(true)
    }).pipe(Effect.provide(TestClock.layer())),
  ))

it("waits for the current prompt before accepting an idle interrupt response", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const launched = yield* Deferred.make<void>()
      const checking = yield* Deferred.make<void>()
      const admitted = yield* Deferred.make<void>()
      const prompt = "Do the work"
      const oldMessage = { id: "msg_prior", type: "user", text: prompt }
      const newMessage = { id: "msg_current", type: "user", text: prompt }
      const calls: string[] = []
      let stopConfirmed = false
      let promptReads = 0
      const turn = yield* runStoppablePlainPrompt({
        target: { sessionId: "ses_resumed", serverKey: "fixture" },
        prompt,
        resumed: true,
        run: Deferred.succeed(launched, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
        track: {
          started: () => Effect.void,
          stopped: () =>
            Effect.sync(() => {
              stopConfirmed = true
            }),
        },
        verifyIdle: Effect.die("Expected interrupt and wait"),
        capture: (args) =>
          Effect.gen(function* () {
            const path = args[2] ?? ""
            if (path.includes("/message?")) {
              promptReads += 1
              if (promptReads <= 2) {
                return { stdout: JSON.stringify({ data: [oldMessage] }) }
              }
              yield* Deferred.succeed(checking, undefined)
              yield* Deferred.await(admitted)
              return {
                stdout: JSON.stringify({ data: [newMessage, oldMessage] }),
              }
            }
            calls.push(path)
            return {
              stdout: path.endsWith("/interrupt")
                ? '{"interrupted":false}'
                : "",
            }
          }),
      }).pipe(Effect.forkChild)

      yield* Deferred.await(launched)
      const stopping = yield* Fiber.interrupt(turn).pipe(Effect.forkChild)
      yield* Deferred.await(checking)
      const callsBeforeAdmission = [...calls]
      yield* Deferred.succeed(admitted, undefined)
      yield* Fiber.join(stopping)
      expect(callsBeforeAdmission).toEqual([])
      expect(calls).toEqual([
        "/api/session/ses_resumed/interrupt",
        "/api/experimental/session/ses_resumed/wait",
      ])
      expect(stopConfirmed).toBe(true)
    }).pipe(Effect.timeout("4 seconds")),
  ))

it("confirms idle without interrupting after a client exits before admission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let persisted = false
      let checkedIdle = false
      const error = new AgentBackendStartupTimeoutError({
        cwd: "/fixture",
        startupTimeoutMs: 10,
      })
      const result = yield* runStoppablePlainPrompt({
        target: { sessionId: "ses_resumed", serverKey: "fixture" },
        resumed: true,
        prompt: "Implement",
        capture: (args) =>
          args[2]?.includes("/message?")
            ? Effect.succeed({ stdout: '{"data":[]}' })
            : Effect.die(
                "Must not send a session-wide interrupt after the client exits",
              ),
        run: Effect.suspend(() => {
          expect(persisted).toBe(true)
          return Effect.fail(error)
        }),
        verifyIdle: Effect.sync(() => {
          checkedIdle = true
        }),
        track: {
          started: () =>
            Effect.sync(() => {
              persisted = true
            }),
          stopped: () =>
            Effect.sync(() => {
              persisted = false
            }),
        },
      }).pipe(Effect.flip)
      expect(result).toBe(error)
      expect(checkedIdle).toBe(true)
      expect(persisted).toBe(false)
    }),
  ))

it("does not interrupt if the client finishes while Reset reads prompt admission", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const launched = yield* Deferred.make<void>()
      const reading = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      let cleared = false
      const turn = yield* runStoppablePlainPrompt({
        target: { sessionId: "ses_fresh", serverKey: "fixture" },
        resumed: false,
        prompt: "Implement",
        run: Deferred.succeed(launched, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
        ),
        capture: (args) =>
          args[2]?.includes("/message?")
            ? Deferred.succeed(reading, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.andThen(Effect.yieldNow),
                Effect.as({
                  stdout:
                    '{"data":[{"type":"user","id":"msg_1","text":"Implement"}]}',
                }),
              )
            : Effect.die(
                "A completed turn must not send a session-wide interrupt",
              ),
        track: {
          started: () => Effect.void,
          stopped: () =>
            Effect.sync(() => {
              cleared = true
            }),
        },
        verifyIdle: Effect.die("The client completed the turn normally"),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(launched)
      const reset = yield* Fiber.interrupt(turn).pipe(Effect.forkChild)
      yield* Deferred.await(reading)
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(reset)
      expect(cleared).toBe(true)
    }).pipe(Effect.timeout("4 seconds")),
  ))
