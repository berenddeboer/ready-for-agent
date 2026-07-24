import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import {
  AgentBackend,
  AgentBackendConfigError,
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  AgentBackendTimeoutError,
  type OnSessionId,
} from "@ready-for-agent/agent-backend"
import { Grok } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "grok-effect-test-"))
  const path = join(directory, "grok")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const provide = (binary: string) =>
  Grok.layer({ binary }).pipe(Layer.provide(BunServices.layer))

const captureSessionScript = [
  'sid=""',
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then sid="$arg"; fi',
  '  prev="$arg"',
  "done",
].join("\n")

const endEvent = `printf '%s\\n' "{\\"type\\":\\"end\\",\\"stopReason\\":\\"EndTurn\\",\\"sessionId\\":\\"$sid\\"}"`

const startTurn = (
  binary: string,
  timeout: string,
  onSessionId?: OnSessionId,
  prompt = "test",
  thinkingLevel: string | null = "medium",
) =>
  Effect.gen(function* () {
    const backend = yield* AgentBackend
    return yield* backend.startTurn({
      cwd: process.cwd(),
      prompt,
      model: "grok-4.5",
      thinkingLevel,
      timeout,
      ...(onSessionId !== undefined ? { onSessionId } : {}),
    })
  }).pipe(Effect.provide(provide(binary)))

describe("Grok AgentBackend adapter", () => {
  it("collects ordered text chunks and ignores thought", async () => {
    await withExecutable(
      [
        'case " $* " in *" --no-auto-update "*) ;; *) exit 20 ;; esac',
        'case " $* " in *" streaming-json "*) ;; *) exit 21 ;; esac',
        'case " $* " in *" --yolo "*) ;; *) exit 22 ;; esac',
        captureSessionScript,
        `printf '%s\\n' '{"type":"thought","data":"ignore"}'`,
        `printf '%s\\n' '{"type":"text","data":"first"}'`,
        `printf '%s\\n' '{"type":"text","data":" second"}'`,
        endEvent,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(startTurn(binary, "2 seconds"))
        expect(result.sessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        )
        expect(result.assistantText).toBe("first second")
      },
    )
  })

  it("notifies onSessionId with the preassigned UUID before process exit", async () => {
    await withExecutable(
      [captureSessionScript, "sleep 0.4", endEvent].join("\n"),
      async (binary) => {
        const observed = await Effect.runPromise(
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<string>()
            const fiber = yield* Effect.forkChild(
              startTurn(binary, "5 seconds", (sessionId) =>
                Deferred.succeed(deferred, sessionId).pipe(Effect.asVoid),
              ),
            )
            const earlySessionId = yield* Deferred.await(deferred)
            const stillRunning = fiber.pollUnsafe() === undefined
            const result = yield* Fiber.await(fiber)
            return { earlySessionId, stillRunning, result }
          }),
        )

        expect(observed.earlySessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        )
        expect(observed.stillRunning).toBe(true)
        expect(Exit.isSuccess(observed.result)).toBe(true)
        if (Exit.isSuccess(observed.result)) {
          expect(observed.result.value.sessionId).toBe(observed.earlySessionId)
        }
      },
    )
  })

  it("resumes exact session and can switch model/effort", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' '{"type":"text","data":"ok"}'`,
        endEvent,
      ].join("\n"),
      async (binary) => {
        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            const started = yield* backend.startTurn({
              cwd: process.cwd(),
              prompt: "first",
              model: "grok-4.5",
              thinkingLevel: "low",
              timeout: "2 seconds",
            })
            const continued = yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: started.sessionId,
              prompt: "second",
              model: "grok-code-fast-1",
              thinkingLevel: "high",
              timeout: "2 seconds",
            })
            return { started, continued }
          }).pipe(Effect.provide(provide(binary))),
        )

        expect(outcome.continued.sessionId).toBe(outcome.started.sessionId)
        expect(outcome.continued.assistantText).toBe("ok")
      },
    )
  })

  it("omits --reasoning-effort when thinkingLevel is null", async () => {
    await withExecutable(
      [
        'case " $* " in *" --reasoning-effort "*) exit 11 ;; esac',
        captureSessionScript,
        endEvent,
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(
            startTurn(binary, "2 seconds", undefined, "test", null),
          ),
        ).resolves.toMatchObject({ assistantText: "" })
      },
    )
  })

  it("maps nonzero exit with observed session", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' '{"type":"text","data":"x"}'`,
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(7)
          expect(error.sessionId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          )
        }
      },
    )
  })

  it("maps timeout while retaining session id", async () => {
    await withExecutable(
      [captureSessionScript, "sleep 10"].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "200 millis").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendTimeoutError)
        if (error instanceof AgentBackendTimeoutError) {
          expect(error.timeoutMs).toBe(200)
          expect(error.sessionId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          )
        }
      },
    )
  })

  it("fails inspect when unauthenticated even if exit is zero", async () => {
    await withExecutable(
      [
        "cat <<'EOF'",
        "You are not authenticated.",
        "",
        "Default model: grok-4.5",
        "",
        "Available models:",
        "  * grok-4.5 (default)",
        "EOF",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.inspect({
              cwd: process.cwd(),
              timeout: "2 seconds",
            })
          }).pipe(Effect.provide(provide(binary)), Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendConfigError)
      },
    )
  })

  it("inspects authenticated model catalog", async () => {
    await withExecutable(
      [
        "cat <<'EOF'",
        "You are logged in with grok.com.",
        "",
        "Default model: grok-4.5",
        "",
        "Available models:",
        "  * grok-4.5 (default)",
        "EOF",
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.inspect({
              cwd: process.cwd(),
              timeout: "2 seconds",
            })
          }).pipe(Effect.provide(provide(binary))),
        )
        expect(result.backend).toEqual({ id: "grok", label: "Grok Build" })
        expect(result.models).toEqual([
          {
            id: "grok-4.5",
            thinkingLevels: ["high", "medium", "low"],
          },
        ])
      },
    )
  })

  it("fails when terminal end event is missing", async () => {
    await withExecutable(
      [`printf '%s\\n' '{"type":"text","data":"only"}'`].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails on session id mismatch in end event", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"end","stopReason":"EndTurn","sessionId":"00000000-0000-4000-8000-000000000099"}'`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("maps max-turn exhaustion to exit failure", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' '{"type":"max_turns_reached"}'`,
        `printf '%s\\n' "{\\"type\\":\\"end\\",\\"stopReason\\":\\"MaxTurns\\",\\"sessionId\\":\\"$sid\\"}"`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
      },
    )
  })

  it("cancels the process tree on fiber interruption", async () => {
    await withExecutable(
      ["trap 'exit 0' TERM", "sleep 30"].join("\n"),
      async (binary) => {
        const exit = await Effect.runPromise(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              startTurn(binary, "30 seconds"),
            )
            yield* Effect.sleep("100 millis")
            yield* Fiber.interrupt(fiber)
            return yield* Fiber.await(fiber)
          }),
        )
        expect(Exit.isSuccess(exit)).toBe(false)
      },
    )
  })
})
