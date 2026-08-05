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
import {
  CLAUDE_STATIC_CATALOG,
  CLAUDE_UNAUTHENTICATED_MESSAGE,
  Claude,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "claude-effect-test-"))
  const path = join(directory, "claude")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const provide = (binary: string) =>
  Claude.layer({ binary }).pipe(Layer.provide(BunServices.layer))

const inspect = (binary: string, timeout = "2 seconds") =>
  Effect.gen(function* () {
    const backend = yield* AgentBackend
    return yield* backend.inspect({
      cwd: process.cwd(),
      timeout,
    })
  }).pipe(Effect.provide(provide(binary)))

const captureSessionScript = [
  'sid=""',
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then sid="$arg"; fi',
  '  prev="$arg"',
  "done",
].join("\n")

/** Fake stream: system init, assistant text, terminal result. */
const successfulTurnStream = (sessionId = "$sid") =>
  [
    `printf '%s\\n' "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"${sessionId}\\"}"`,
    `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"${sessionId}\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"ok\\"}]}}"`,
    `printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"session_id\\":\\"${sessionId}\\",\\"is_error\\":false,\\"result\\":\\"ok\\"}"`,
  ].join("\n")

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
      model: "sonnet",
      thinkingLevel,
      timeout,
      ...(onSessionId !== undefined ? { onSessionId } : {}),
    })
  }).pipe(Effect.provide(provide(binary)))

describe("Claude AgentBackend adapter (readiness inspection)", () => {
  it("inspects authenticated CLI via JSON auth status (real CLI shape)", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        // Env must force auto-update off on inspect too.
        'if [ "$DISABLE_AUTOUPDATER" != "1" ]; then exit 21; fi',
        'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"op@example.com"}\'',
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(inspect(binary))
        expect(result.backend).toEqual({
          id: "claude",
          label: "Claude Code",
        })
        expect(result.models).toEqual(
          CLAUDE_STATIC_CATALOG.map((model) => ({
            id: model.id,
            thinkingLevels: [...model.thinkingLevels],
          })),
        )
        expect(result.models.map((m) => m.id)).toEqual([
          "haiku",
          "sonnet",
          "opus",
          "fable",
        ])
        for (const model of result.models) {
          expect(model.thinkingLevels).toEqual([
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ])
          expect(model.thinkingLevels).not.toContain("ultracode")
        }
      },
    )
  })

  it("inspects Ready when auth status is Bedrock third-party (static alias catalog)", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        'if [ "$DISABLE_AUTOUPDATER" != "1" ]; then exit 21; fi',
        // Real Claude Code Bedrock shape (issue #801 / epic #799).
        'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}\'',
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(inspect(binary))
        expect(result.backend).toEqual({
          id: "claude",
          label: "Claude Code",
        })
        expect(result.models.map((m) => m.id)).toEqual([
          "haiku",
          "sonnet",
          "opus",
          "fable",
        ])
        expect(result.models).toEqual(
          CLAUDE_STATIC_CATALOG.map((model) => ({
            id: model.id,
            thinkingLevels: [...model.thinkingLevels],
          })),
        )
        for (const model of result.models) {
          expect(model.thinkingLevels).toEqual([
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ])
        }
      },
    )
  })

  it("fails inspect with actionable config error when unauthenticated", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        "printf '%s\\n' '{\"loggedIn\":false}'",
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toBe(CLAUDE_UNAUTHENTICATED_MESSAGE)
          expect(error.message).toContain("claude auth login")
          expect(error.message).toContain("ANTHROPIC_API_KEY")
        }
      },
    )
  })

  it("keeps first-party loggedIn false on the login/API-key path (not Bedrock)", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        'printf \'%s\\n\' \'{"loggedIn":false,"authMethod":null,"apiProvider":"firstParty"}\'',
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toBe(CLAUDE_UNAUTHENTICATED_MESSAGE)
          expect(error.message).toContain("claude auth login")
          expect(error.message).toContain("ANTHROPIC_API_KEY")
          expect(error.message.toLowerCase()).not.toContain("bedrock")
        }
      },
    )
  })

  it("maps non-zero auth status without auth markers to config error with probe text", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        "echo 'internal crash' 1>&2",
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toContain("exit 7")
          expect(error.message).toContain("internal crash")
          expect(error.message).not.toBe(CLAUDE_UNAUTHENTICATED_MESSAGE)
        }
      },
    )
  })

  it("fails inspect when auth status output is malformed", async () => {
    await withExecutable(
      [
        'case " $* " in *" auth status "*) ;; *) exit 20 ;; esac',
        "echo 'something unexpected without auth markers'",
        "exit 0",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails inspect when the binary is missing", async () => {
    const missing = join(tmpdir(), `claude-missing-${Date.now()}`)
    const error = await Effect.runPromise(inspect(missing).pipe(Effect.flip))
    expect(error).toBeDefined()
    expect(error).not.toBeInstanceOf(AgentBackendConfigError)
    expect((error as { _tag?: string })._tag).toBe("PlatformError")
    const reason = (error as { reason?: { _tag?: string } }).reason
    expect(reason?._tag).toBe("NotFound")
  })
})

describe("Claude AgentBackend adapter (Agent Turns)", () => {
  it("requires print mode, stream-json, verbose, permissions skip, and DISABLE_AUTOUPDATER", async () => {
    await withExecutable(
      [
        'case " $* " in *" -p "*) ;; *) exit 20 ;; esac',
        'case " $* " in *" stream-json "*) ;; *) exit 21 ;; esac',
        'case " $* " in *" --verbose "*) ;; *) exit 22 ;; esac',
        'case " $* " in *" --dangerously-skip-permissions "*) ;; *) exit 23 ;; esac',
        'case " $* " in *" --bare "*) exit 24 ;; esac',
        'case " $* " in *" --continue "*) exit 25 ;; esac',
        'case " $* " in *" --fork-session "*) exit 26 ;; esac',
        'if [ "$DISABLE_AUTOUPDATER" != "1" ]; then exit 27; fi',
        captureSessionScript,
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(startTurn(binary, "2 seconds"))
        expect(result.assistantText).toBe("ok")
        expect(result.sessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        )
      },
    )
  })

  it("collects terminal result text", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"$sid\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"first\\"}]}}"`,
        `printf '%s\\n' "{\\"type\\":\\"result\\",\\"session_id\\":\\"$sid\\",\\"is_error\\":false,\\"result\\":\\"final answer\\"}"`,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(startTurn(binary, "2 seconds"))
        expect(result.assistantText).toBe("final answer")
      },
    )
  })

  it("notifies onSessionId with the preassigned UUID before process exit", async () => {
    await withExecutable(
      [captureSessionScript, "sleep 0.4", successfulTurnStream()].join("\n"),
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

  it("passes --session-id on start and --resume on continue with model/effort restated", async () => {
    await withExecutable(
      [
        // Continue path first when --resume is present.
        'case " $* " in *" --resume "*)',
        '  case " $* " in *" --model opus "*) ;; *) exit 30 ;; esac',
        '  case " $* " in *" --effort high "*) ;; *) exit 31 ;; esac',
        '  case " $* " in *" --session-id "*) exit 32 ;; esac',
        '  case " $* " in *" --continue "*) exit 33 ;; esac',
        '  case " $* " in *" --fork-session "*) exit 34 ;; esac',
        captureSessionScript,
        successfulTurnStream(),
        "  exit 0",
        "  ;;",
        "esac",
        // Start turn: no resume
        'case " $* " in *" --resume "*) exit 35 ;; esac',
        'case " $* " in *" --session-id "*) ;; *) exit 36 ;; esac',
        'case " $* " in *" --model sonnet "*) ;; *) exit 37 ;; esac',
        'case " $* " in *" --effort low "*) ;; *) exit 38 ;; esac',
        captureSessionScript,
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            const started = yield* backend.startTurn({
              cwd: process.cwd(),
              prompt: "first",
              model: "sonnet",
              thinkingLevel: "low",
              timeout: "2 seconds",
            })
            const continued = yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: started.sessionId,
              prompt: "second",
              model: "opus",
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

  it("omits --effort when thinkingLevel is null", async () => {
    await withExecutable(
      [
        'case " $* " in *" --effort "*) exit 11 ;; esac',
        captureSessionScript,
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(
            startTurn(binary, "2 seconds", undefined, "test", null),
          ),
        ).resolves.toMatchObject({ assistantText: "ok" })
      },
    )
  })

  it("prefixes /review into the prompt on continueTurn", async () => {
    await withExecutable(
      [
        'case " $* " in *"/review"*) ;; *) exit 40 ;; esac',
        captureSessionScript,
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: "11111111-1111-4111-8111-111111111111",
              command: "/review",
              prompt: "Review uncommitted worktree changes.",
              model: "sonnet",
              thinkingLevel: null,
              timeout: "2 seconds",
            })
          }).pipe(Effect.provide(provide(binary))),
        )
        expect(result.sessionId).toBe("11111111-1111-4111-8111-111111111111")
        expect(result.assistantText).toBe("ok")
      },
    )
  })

  it("maps result is_error to exit failure with known session", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' "{\\"type\\":\\"result\\",\\"subtype\\":\\"error\\",\\"session_id\\":\\"$sid\\",\\"is_error\\":true,\\"error\\":\\"boom\\"}"`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(1)
          expect(error.sessionId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          )
        }
      },
    )
  })

  it("maps nonzero exit with known session", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"$sid\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"x\\"}]}}"`,
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

  it("maps timeout while retaining preassigned session id", async () => {
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

  it("fails when terminal result event is missing", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"$sid\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"only\\"}]}}"`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails on malformed stream lines", async () => {
    await withExecutable(
      [
        captureSessionScript,
        "echo not-json",
        `printf '%s\\n' "{\\"type\\":\\"result\\",\\"session_id\\":\\"$sid\\",\\"is_error\\":false,\\"result\\":\\"x\\"}"`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails on session id mismatch in result event", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"result","session_id":"00000000-0000-4000-8000-000000000099","is_error":false,"result":"x"}'`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
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
