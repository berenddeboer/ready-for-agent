import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { FAKE_ACP_ENV, fakeAcpAgentPath } from "@ready-for-agent/acp-client"
import {
  AgentBackend,
  AgentBackendConfigError,
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  AgentBackendStartupTimeoutError,
  AgentBackendTimeoutError,
  type OnSessionId,
  PROMPT_ARGV_BYTE_LIMIT,
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

const provide = (
  binary: string,
  options: {
    readonly startupTimeout?: string
    readonly forceKillAfter?: string
  } = {},
) =>
  Grok.layer({
    binary,
    ...(options.startupTimeout !== undefined
      ? { startupTimeout: options.startupTimeout }
      : {}),
    ...(options.forceKillAfter !== undefined
      ? { forceKillAfter: options.forceKillAfter }
      : {}),
  }).pipe(Layer.provide(BunServices.layer))

const captureSessionScript = [
  'sid=""',
  'prev=""',
  'for arg in "$@"; do',
  '  if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then sid="$arg"; fi',
  '  prev="$arg"',
  "done",
].join("\n")

const endEvent = `printf '%s\\n' "{\\"type\\":\\"end\\",\\"stopReason\\":\\"EndTurn\\",\\"sessionId\\":\\"$sid\\"}"`

const withAcpGrok = async <A>(
  use: (path: string) => Promise<A>,
  script = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAcpAgentPath)}`,
): Promise<A> => withExecutable(script, use)

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

const continueTurn = (
  binary: string,
  input: {
    readonly sessionId?: string
    readonly prompt?: string
    readonly model?: string
    readonly thinkingLevel?: string | null
    readonly command?: string
    readonly timeout?: string
    readonly startupTimeout?: string
    readonly forceKillAfter?: string
  } = {},
) =>
  Effect.gen(function* () {
    const backend = yield* AgentBackend
    return yield* backend.continueTurn({
      cwd: process.cwd(),
      sessionId: input.sessionId ?? SESSION_ID,
      prompt: input.prompt ?? "second",
      model: input.model ?? "grok-code-fast-1",
      thinkingLevel:
        input.thinkingLevel === undefined ? "high" : input.thinkingLevel,
      timeout: input.timeout ?? "5 seconds",
      ...(input.command !== undefined ? { command: input.command } : {}),
    })
  }).pipe(
    Effect.provide(
      provide(binary, {
        ...(input.startupTimeout !== undefined
          ? { startupTimeout: input.startupTimeout }
          : {}),
        ...(input.forceKillAfter !== undefined
          ? { forceKillAfter: input.forceKillAfter }
          : {}),
      }),
    ),
  )

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

  it("passes a large single-line prompt in a scoped prompt file, not argv", async () => {
    // Single-line and past the argv byte limit: on argv this spawn fails with an
    // opaque platform error. Headless Grok ignores piped stdin, so the body
    // travels in a temp file that only lives as long as the turn.
    const prompt = `Fix ${"x".repeat(PROMPT_ARGV_BYTE_LIMIT)}`
    await withExecutable(
      [
        'file=""',
        'p=""',
        'for arg in "$@"; do',
        '  if [ "$p" = "--prompt-file" ]; then file="$arg"; fi',
        '  p="$arg"',
        "done",
        '[ -n "$file" ] || exit 30',
        'case " $* " in *" -p "*) exit 31 ;; esac',
        // Record what the CLI saw so the test can assert after the turn, when
        // the scoped file is already gone.
        'out="$(dirname "$0")"',
        'printf \'%s\' "$file" > "$out/prompt-path"',
        'wc -c < "$file" | tr -d " \\n" > "$out/prompt-bytes"',
        'head -c 5 "$file" > "$out/prompt-head"',
        captureSessionScript,
        endEvent,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          startTurn(binary, "10 seconds", undefined, prompt),
        )
        expect(result.assistantText).toBe("")

        const out = dirname(binary)
        const promptPath = await readFile(join(out, "prompt-path"), "utf8")
        expect(await readFile(join(out, "prompt-bytes"), "utf8")).toBe(
          String(Buffer.byteLength(prompt, "utf8")),
        )
        expect(await readFile(join(out, "prompt-head"), "utf8")).toBe("Fix x")
        // Scoped: the prompt file is removed once the turn finishes.
        await expect(stat(promptPath)).rejects.toThrow()
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
    await withAcpGrok(async (binary) => {
      const continued = await Effect.runPromise(continueTurn(binary))
      expect(continued.sessionId).toBe(SESSION_ID)
      expect(continued.assistantText).toBe("hello from fake agent")
    })
  })

  it("falls back to load then prompt when resume fails", async () => {
    await withAcpGrok(
      async (binary) => {
        const continued = await Effect.runPromise(continueTurn(binary))
        expect(continued.sessionId).toBe(SESSION_ID)
        expect(continued.assistantText).toBe("hello from fake agent")
      },
      [
        `export ${FAKE_ACP_ENV.resumeFail}=1`,
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAcpAgentPath)}`,
      ].join("\n"),
    )
  })

  it("fails when the ACP agent exits before prompt completes", async () => {
    await withAcpGrok(
      async (binary) => {
        const error = await Effect.runPromise(
          continueTurn(binary).pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.sessionId).toBe(SESSION_ID)
          expect(error.message).toContain("exited before")
        }
      },
      [
        `export ${FAKE_ACP_ENV.exitBeforePrompt}=1`,
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAcpAgentPath)}`,
      ].join("\n"),
    )
  })

  it("fails a silent hang as a startup failure, not a full-turn timeout", async () => {
    await withExecutable("sleep 10", async (binary) => {
      const error = await Effect.runPromise(
        continueTurn(binary, {
          timeout: "2 seconds",
          startupTimeout: "200 millis",
        }).pipe(Effect.flip),
      )
      expect(error).toBeInstanceOf(AgentBackendStartupTimeoutError)
      if (error instanceof AgentBackendStartupTimeoutError) {
        expect(error.startupTimeoutMs).toBe(200)
        expect(error.sessionId).toBe(SESSION_ID)
      }
    })
  })

  it("fails a refused Session continue with a diagnosable Agent Backend error", async () => {
    await withAcpGrok(
      async (binary) => {
        const error = await Effect.runPromise(
          continueTurn(binary).pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.sessionId).toBe(SESSION_ID)
          expect(error.message).toContain("could not restore Session")
          expect(error.message).toContain(SESSION_ID)
        }
      },
      [
        `export ${FAKE_ACP_ENV.resumeFail}=1`,
        `export ${FAKE_ACP_ENV.loadFail}=1`,
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAcpAgentPath)}`,
      ].join("\n"),
    )
  })

  it("rejects a Session ID mismatch from the ACP agent", async () => {
    const reported = "00000000-0000-4000-8000-000000000099"
    await withAcpGrok(
      async (binary) => {
        const error = await Effect.runPromise(
          continueTurn(binary).pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
      },
      [
        `export ${FAKE_ACP_ENV.reportedSessionId}=${JSON.stringify(reported)}`,
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAcpAgentPath)}`,
      ].join("\n"),
    )
  })

  it("prefixes /review into the ACP prompt on continueTurn", async () => {
    await withAcpGrok(
      async (binary) => {
        const continued = await Effect.runPromise(
          continueTurn(binary, {
            command: "/review",
            prompt: "Review uncommitted worktree changes.",
          }),
        )
        expect(continued.sessionId).toBe(SESSION_ID)
        expect(continued.assistantText).toBe(
          "/review\nReview uncommitted worktree changes.",
        )
      },
      [
        `export ${FAKE_ACP_ENV.echoPrompt}=1`,
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAcpAgentPath)}`,
      ].join("\n"),
    )
  })

  it("passes model, thinking level, and always-approve on the ACP spawn", async () => {
    await withAcpGrok(
      async (binary) => {
        const continued = await Effect.runPromise(
          continueTurn(binary, {
            model: "grok-code-fast-1",
            thinkingLevel: "high",
          }),
        )
        expect(continued.sessionId).toBe(SESSION_ID)
      },
      [
        'case " $* " in *" --no-auto-update "*) ;; *) exit 20 ;; esac',
        'case " $* " in *" agent "*) ;; *) exit 21 ;; esac',
        'case " $* " in *" --no-leader "*) ;; *) exit 22 ;; esac',
        'case " $* " in *" --always-approve "*) ;; *) exit 23 ;; esac',
        'case " $* " in *" -m grok-code-fast-1 "*) ;; *) exit 24 ;; esac',
        'case " $* " in *" --reasoning-effort high "*) ;; *) exit 25 ;; esac',
        'case " $* " in *" stdio "*) ;; *) exit 26 ;; esac',
        'case " $* " in *" --resume "*) exit 27 ;; esac',
        'case " $* " in *" -p "*) exit 28 ;; esac',
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAcpAgentPath)}`,
      ].join("\n"),
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
          expect(error.message).toBe("Grok Build failed with exit code 7")
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

  it("surfaces a stderr-only readiness failure as the inspect exit reason", async () => {
    await withExecutable(
      [
        "printf 'Error: Configuration is invalid at /home/vscode/.config/grok/config.json\\n' >&2",
        "exit 1",
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
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(1)
          expect(error.message).toContain(
            "Configuration is invalid at /home/vscode/.config/grok/config.json",
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
        "Default model: grok-4.6",
        "",
        "Available models:",
        "  * grok-4.6 (default)",
        "  - grok-4.5",
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
            id: "grok-4.6",
            thinkingLevels: ["xhigh", "high", "medium", "low"],
          },
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

  it("classifies a stream credential error as terminal_auth_error", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' '{"type":"error","message":"Unable to locate credentials"}'`,
        `printf '%s\\n' "{\\"type\\":\\"end\\",\\"stopReason\\":\\"EndTurn\\",\\"sessionId\\":\\"$sid\\"}"`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.classification).toBe("terminal_auth_error")
          expect(error.message).toBe("Unable to locate credentials")
        }
      },
    )
  })

  it("maps stream error events to exit failure with the reported reason", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' '{"type":"error","message":"auth failed"}'`,
        `printf '%s\\n' "{\\"type\\":\\"end\\",\\"stopReason\\":\\"EndTurn\\",\\"sessionId\\":\\"$sid\\"}"`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(1)
          expect(error.message).toBe("auth failed")
        }
      },
    )
  })

  it("maps max-turn exhaustion to exit failure", async () => {
    await withExecutable(
      [
        captureSessionScript,
        `printf '%s\\n' '{"type":"max_turns_reached"}'`,
        `printf '%s\\n' "{\\"type\\":\\"end\\",\\"stopReason\\":\\"MaxTurns\\",\\"sessionId\\":\\"$sid\\"}"`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(1)
          expect(error.message).toContain("maximum number of turns")
        }
      },
    )
  })

  it("terminates the continueTurn process tree on turn timeout", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "grok-acp-tree-"))
    const childAlive = join(markerDir, "child-alive")
    const grandPidFile = join(markerDir, "grand.pid")
    try {
      await withAcpGrok(
        async (binary) => {
          const error = await Effect.runPromise(
            continueTurn(binary, {
              timeout: "400 millis",
              forceKillAfter: "100 millis",
            }).pipe(Effect.flip),
          )
          expect(error).toBeInstanceOf(AgentBackendTimeoutError)
          await Bun.sleep(300)
          const grandPid = Number(
            (
              await Bun.file(grandPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(grandPid) && grandPid > 0).toBe(true)
          expect(isPidAlive(grandPid)).toBe(false)
          const stillTouched = await Bun.file(childAlive)
            .stat()
            .then((s) => Date.now() - s.mtime.getTime() < 200)
            .catch(() => false)
          expect(stillTouched).toBe(false)
        },
        [
          `( while true; do touch ${JSON.stringify(childAlive)}; sleep 0.05; done ) &`,
          `echo $! > ${JSON.stringify(grandPidFile)}`,
          `export ${FAKE_ACP_ENV.promptDelayMs}=30000`,
          `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAcpAgentPath)}`,
        ].join("\n"),
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("terminates the continueTurn process tree on fiber interruption", async () => {
    const markerDir = await mkdtemp(join(tmpdir(), "grok-acp-interrupt-"))
    const childAlive = join(markerDir, "child-alive")
    const grandPidFile = join(markerDir, "grand.pid")
    try {
      await withAcpGrok(
        async (binary) => {
          await Effect.runPromise(
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(
                continueTurn(binary, {
                  timeout: "30 seconds",
                  forceKillAfter: "100 millis",
                }),
              )
              yield* Effect.sleep("200 millis")
              yield* Fiber.interrupt(fiber)
              return yield* Fiber.await(fiber)
            }),
          )
          await Bun.sleep(300)
          const grandPid = Number(
            (
              await Bun.file(grandPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(grandPid) && grandPid > 0).toBe(true)
          expect(isPidAlive(grandPid)).toBe(false)
          const stillTouched = await Bun.file(childAlive)
            .stat()
            .then((s) => Date.now() - s.mtime.getTime() < 200)
            .catch(() => false)
          expect(stillTouched).toBe(false)
        },
        [
          `( while true; do touch ${JSON.stringify(childAlive)}; sleep 0.05; done ) &`,
          `echo $! > ${JSON.stringify(grandPidFile)}`,
          `export ${FAKE_ACP_ENV.promptDelayMs}=30000`,
          `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAcpAgentPath)}`,
        ].join("\n"),
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
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

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
