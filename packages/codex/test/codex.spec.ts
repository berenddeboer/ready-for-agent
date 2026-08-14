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
  AgentBackendNotInstalledError,
  AgentBackendSessionIdMissingError,
  AgentBackendTimeoutError,
  type OnSessionId,
  PROMPT_ARGV_BYTE_LIMIT,
} from "@ready-for-agent/agent-backend"
import {
  CODEX_STATIC_CATALOG,
  CODEX_UNAUTHENTICATED_MESSAGE,
  Codex,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "codex-effect-test-"))
  const path = join(directory, "codex")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const provide = (binary: string) =>
  Codex.layer({ binary }).pipe(Layer.provide(BunServices.layer))

const inspect = (binary: string, timeout = "2 seconds") =>
  Effect.gen(function* () {
    const backend = yield* AgentBackend
    return yield* backend.inspect({
      cwd: process.cwd(),
      timeout,
    })
  }).pipe(Effect.provide(provide(binary)))

/** Fake stream: early thread.started, agent_message, turn.completed. */
const successfulTurnStream = (
  threadId = "019fab2c-9466-7432-ad16-9de23f94f2db",
) =>
  [
    `printf '%s\\n' '{"type":"thread.started","thread_id":"${threadId}"}'`,
    `printf '%s\\n' '{"type":"turn.started"}'`,
    `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}'`,
    `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'`,
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
      model: "gpt-5.5",
      thinkingLevel,
      timeout,
      ...(onSessionId !== undefined ? { onSessionId } : {}),
    })
  }).pipe(Effect.provide(provide(binary)))

describe("Codex AgentBackend adapter (readiness inspection)", () => {
  it("inspects authenticated CLI via stderr status (real CLI shape)", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        // Real codex prints status with eprintln! (stderr only, empty stdout).
        "echo 'Logged in using ChatGPT' 1>&2",
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(inspect(binary))
        expect(result.backend).toEqual({ id: "codex", label: "Codex Build" })
        expect(result.models).toEqual(
          CODEX_STATIC_CATALOG.map((model) => ({
            id: model.id,
            thinkingLevels: [...model.thinkingLevels],
          })),
        )
      },
    )
  })

  it("inspects when API key login is stored (stderr status)", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        "echo 'Logged in using an API key - sk-test' 1>&2",
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(inspect(binary))
        expect(result.backend.id).toBe("codex")
        expect(result.models.length).toBeGreaterThan(0)
      },
    )
  })

  it("fails inspect with actionable config error when unauthenticated (stderr)", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        "echo 'Not logged in' 1>&2",
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toBe(CODEX_UNAUTHENTICATED_MESSAGE)
          expect(error.message).toContain("codex login")
          expect(error.message).toContain("OPENAI_API_KEY")
        }
      },
    )
  })

  it("prefers parsed unauthenticated copy over extra stderr noise", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        "echo 'Not logged in' 1>&2",
        "echo 'raw stderr should lose' 1>&2",
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendConfigError)
        if (error instanceof AgentBackendConfigError) {
          expect(error.message).toBe(CODEX_UNAUTHENTICATED_MESSAGE)
          expect(error.message).not.toContain("raw stderr should lose")
        }
      },
    )
  })

  it("maps non-zero login status without auth markers to exit failure with probe text", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        "echo 'internal crash' 1>&2",
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(7)
          expect(error.message).toContain("internal crash")
        }
      },
    )
  })

  it("fails inspect when login status output is malformed", async () => {
    await withExecutable(
      [
        'case " $* " in *" login status "*) ;; *) exit 20 ;; esac',
        "echo 'something unexpected without auth markers' 1>&2",
        "exit 0",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(inspect(binary).pipe(Effect.flip))
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails inspect when the binary is missing", async () => {
    const missing = join(tmpdir(), `codex-missing-${Date.now()}`)
    const error = await Effect.runPromise(inspect(missing).pipe(Effect.flip))
    expect(error).toBeInstanceOf(AgentBackendNotInstalledError)
    if (error instanceof AgentBackendNotInstalledError) {
      expect(error.binary).toBe(missing)
      expect(error.message).toContain(
        `Codex Build CLI "${missing}" was not found on the Harness PATH.`,
      )
      expect(error.message).toContain("restart the Harness")
    }
  })
})

describe("Codex AgentBackend adapter (Agent Turns)", () => {
  it("requires exec --json, danger-full-access, and never-approval on every turn", async () => {
    await withExecutable(
      [
        'case " $* " in *" exec "*) ;; *) exit 20 ;; esac',
        'case " $* " in *" --json "*) ;; *) exit 21 ;; esac',
        'case " $* " in *" danger-full-access "*) ;; *) exit 22 ;; esac',
        'case " $* " in *" approval_policy=never "*) ;; *) exit 23 ;; esac',
        successfulTurnStream(),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(startTurn(binary, "2 seconds"))
        expect(result.assistantText).toBe("ok")
        expect(result.sessionId).toBe("019fab2c-9466-7432-ad16-9de23f94f2db")
      },
    )
  })

  it("sends a large single-line prompt through stdin instead of argv", async () => {
    // Single-line and past the argv byte limit: on argv this spawn fails with
    // an opaque platform error rather than reaching the CLI at all.
    const prompt = `Fix ${"x".repeat(PROMPT_ARGV_BYTE_LIMIT)}`
    await withExecutable(
      [
        // `-` is the only positional prompt; the body arrives on stdin.
        'case " $* " in *" -- - ") ;; *) exit 30 ;; esac',
        "input=$(cat)",
        `[ \${#input} -eq ${prompt.length} ] || exit 31`,
        'case "$input" in "Fix x"*) ;; *) exit 32 ;; esac',
        successfulTurnStream("thread-large"),
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(startTurn(binary, "10 seconds", undefined, prompt)),
        ).resolves.toEqual({
          sessionId: "thread-large",
          assistantText: "ok",
        })
      },
    )
  })

  it("collects ordered agent_message text and ignores other item types", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"thread-abc"}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"think"}}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"first"}}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":" second"}}'`,
        `printf '%s\\n' '{"type":"turn.completed"}'`,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(startTurn(binary, "2 seconds"))
        expect(result.sessionId).toBe("thread-abc")
        expect(result.assistantText).toBe("first second")
      },
    )
  })

  it("notifies onSessionId from thread.started while the first turn is still running", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"early-thread-id"}'`,
        "sleep 0.4",
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"done"}}'`,
        `printf '%s\\n' '{"type":"turn.completed"}'`,
      ].join("\n"),
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

        expect(observed.earlySessionId).toBe("early-thread-id")
        expect(observed.stillRunning).toBe(true)
        expect(Exit.isSuccess(observed.result)).toBe(true)
        if (Exit.isSuccess(observed.result)) {
          expect(observed.result.value.sessionId).toBe(observed.earlySessionId)
        }
      },
    )
  })

  it("resumes by session id and restates model and reasoning effort", async () => {
    await withExecutable(
      [
        // First turn: start
        'case " $* " in *" resume "*)',
        '  case " $* " in *" gpt-5.6-sol "*) ;; *) exit 30 ;; esac',
        '  case " $* " in *" model_reasoning_effort=high "*) ;; *) exit 31 ;; esac',
        '  case " $* " in *" thread-from-start "*) ;; *) exit 32 ;; esac',
        successfulTurnStream("thread-from-start"),
        "  exit 0",
        "  ;;",
        "esac",
        // Start turn: no resume
        'case " $* " in *" resume "*) exit 33 ;; esac',
        'case " $* " in *" gpt-5.5 "*) ;; *) exit 34 ;; esac',
        'case " $* " in *" model_reasoning_effort=low "*) ;; *) exit 35 ;; esac',
        successfulTurnStream("thread-from-start"),
      ].join("\n"),
      async (binary) => {
        const outcome = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            const started = yield* backend.startTurn({
              cwd: process.cwd(),
              prompt: "first",
              model: "gpt-5.5",
              thinkingLevel: "low",
              timeout: "2 seconds",
            })
            const continued = yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: started.sessionId,
              prompt: "second",
              model: "gpt-5.6-sol",
              thinkingLevel: "high",
              timeout: "2 seconds",
            })
            return { started, continued }
          }).pipe(Effect.provide(provide(binary))),
        )

        expect(outcome.started.sessionId).toBe("thread-from-start")
        expect(outcome.continued.sessionId).toBe(outcome.started.sessionId)
        expect(outcome.continued.assistantText).toBe("ok")
      },
    )
  })

  it("omits model_reasoning_effort when thinkingLevel is null", async () => {
    await withExecutable(
      [
        'case " $* " in *" model_reasoning_effort="*) exit 11 ;; esac',
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

  it("continueTurn succeeds without a second thread.started using seeded session id", async () => {
    await withExecutable(
      [
        'case " $* " in *" resume "*) ;; *) exit 50 ;; esac',
        'case " $* " in *" seeded-thread "*) ;; *) exit 51 ;; esac',
        // No thread.started — durable ID comes from continueTurn input.
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"resumed-ok"}}'`,
        `printf '%s\\n' '{"type":"turn.completed"}'`,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: "seeded-thread",
              prompt: "continue without stream session event",
              model: "gpt-5.5",
              thinkingLevel: null,
              timeout: "2 seconds",
            })
          }).pipe(Effect.provide(provide(binary))),
        )
        expect(result.sessionId).toBe("seeded-thread")
        expect(result.assistantText).toBe("resumed-ok")
      },
    )
  })

  it("prefixes /review into the prompt on continueTurn", async () => {
    await withExecutable(
      [
        'case " $* " in *"/review"*) ;; *) exit 40 ;; esac',
        successfulTurnStream("review-thread"),
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.continueTurn({
              cwd: process.cwd(),
              sessionId: "review-thread",
              command: "/review",
              prompt: "Review uncommitted worktree changes.",
              model: "gpt-5.5",
              thinkingLevel: null,
              timeout: "2 seconds",
            })
          }).pipe(Effect.provide(provide(binary))),
        )
        expect(result.sessionId).toBe("review-thread")
        expect(result.assistantText).toBe("ok")
      },
    )
  })

  it("classifies a turn.failed credential rejection as terminal_auth_error", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"auth-thread"}'`,
        `printf '%s\\n' '{"type":"turn.failed","error":{"message":"ExpiredToken: token has expired"}}'`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.classification).toBe("terminal_auth_error")
          expect(error.message).toBe("ExpiredToken: token has expired")
        }
      },
    )
  })

  it("maps turn.failed to exit failure with observed session", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"fail-thread"}'`,
        `printf '%s\\n' '{"type":"turn.failed","error":{"message":"boom"}}'`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(1)
          expect(error.message).toBe("boom")
          expect(error.sessionId).toBe("fail-thread")
        }
      },
    )
  })

  it("maps nonzero exit with observed session", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"exit-thread"}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"x"}}'`,
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(7)
          expect(error.message).toBe("Codex Build failed with exit code 7")
          expect(error.sessionId).toBe("exit-thread")
        }
      },
    )
  })

  it("maps timeout while retaining session id from thread.started", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"timeout-thread"}'`,
        "sleep 10",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "200 millis").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendTimeoutError)
        if (error instanceof AgentBackendTimeoutError) {
          expect(error.timeoutMs).toBe(200)
          expect(error.sessionId).toBe("timeout-thread")
        }
      },
    )
  })

  it("fails when terminal turn.completed is missing", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"t1"}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"only"}}'`,
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
        `printf '%s\\n' '{"type":"thread.started","thread_id":"t1"}'`,
        "echo not-json",
        `printf '%s\\n' '{"type":"turn.completed"}'`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
    )
  })

  it("fails startTurn when thread.started never arrives", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"x"}}'`,
        `printf '%s\\n' '{"type":"turn.completed"}'`,
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        // Missing session id: either SessionIdMissing or malformed after fold.
        expect(
          error instanceof AgentBackendSessionIdMissingError ||
            error instanceof AgentBackendMalformedOutputError,
        ).toBe(true)
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
