import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import {
  AgentBackend,
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  AgentBackendTimeoutError,
  type OnSessionId,
} from "@ready-for-agent/agent-backend"
import { Opencode, parseVerboseModelsOutput } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-effect-test-"))
  const path = join(directory, "opencode")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const startTurn = (
  binary: string,
  timeout: string,
  onSessionId?: OnSessionId,
  prompt = "test",
  thinkingLevel: string | null = "test",
) =>
  Effect.gen(function* () {
    const backend = yield* AgentBackend
    return yield* backend.startTurn({
      cwd: process.cwd(),
      prompt,
      model: "test/model",
      thinkingLevel,
      timeout,
      ...(onSessionId !== undefined ? { onSessionId } : {}),
    })
  }).pipe(
    Effect.provide(
      Opencode.layer({
        binary,
        keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
      }).pipe(Layer.provide(BunServices.layer)),
    ),
  )

describe("Opencode AgentBackend adapter", () => {
  it("collects structured output from a scoped child process", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_test"}'`,
        `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"first"}}'`,
        `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"second"}}'`,
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(startTurn(binary, "2 seconds")),
        ).resolves.toEqual({
          sessionId: "ses_test",
          assistantText: "first\nsecond",
        })
      },
    )
  })

  it("sends multi-line prompts through stdin without changing their structure", async () => {
    const prompt = "first\nsecond"
    await withExecutable(
      [
        "input=$(cat)",
        "expected=$(printf 'first\\nsecond')",
        '[ "$input" = "$expected" ] || exit 9',
        `printf '%s\n' '{"type":"step_start","sessionID":"ses_stdin"}'`,
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(startTurn(binary, "2 seconds", undefined, prompt)),
        ).resolves.toEqual({
          sessionId: "ses_stdin",
          assistantText: "",
        })
      },
    )
  })

  it("omits --variant when thinkingLevel is null", async () => {
    await withExecutable(
      [
        'printf "%s\\n" "$*" > /tmp/opencode-args-$$.txt 2>/dev/null || true',
        'case " $* " in *" --variant "*) exit 11 ;; esac',
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_default"}'`,
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(
            startTurn(binary, "2 seconds", undefined, "test", null),
          ),
        ).resolves.toEqual({
          sessionId: "ses_default",
          assistantText: "",
        })
      },
    )
  })

  it("returns a typed exit error with the observed session", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_failed"}'`,
        "exit 7",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toEqual(
          new AgentBackendExitError({
            exitCode: 7,
            cwd: process.cwd(),
            sessionId: "ses_failed",
          }),
        )
      },
    )
  })

  it("retains an observed session in the typed timeout error", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_timeout"}'`,
        "sleep 10",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "200 millis").pipe(Effect.flip),
        )
        expect(error).toEqual(
          new AgentBackendTimeoutError({
            cwd: process.cwd(),
            timeoutMs: 200,
            sessionId: "ses_timeout",
          }),
        )
      },
    )
  })

  it("notifies onSessionId with the first streamed sessionID before process exit", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_early"}'`,
        "sleep 0.4",
        `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"done"}}'`,
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

        expect(observed.earlySessionId).toBe("ses_early")
        expect(observed.stillRunning).toBe(true)
        expect(Exit.isSuccess(observed.result)).toBe(true)
        if (Exit.isSuccess(observed.result)) {
          expect(observed.result.value.sessionId).toBe("ses_early")
        }
      },
    )
  })

  it("returns the /review child task result and ignores resumed parent text", async () => {
    const childText = [
      "## Review Findings",
      "- Medium: nullable thinking level treated as required",
      "",
      "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium",
    ].join("\n")
    const toolUse = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_parent",
      part: {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: {
            prompt: "Review uncommitted worktree changes.",
            description: "review changes",
            subagent_type: "build",
            command: "review",
          },
          output: `<task id="ses_review_child" state="completed">\n<task_result>\n${childText}\n</task_result>\n</task>`,
        },
      },
    })
    const parentFixed = JSON.stringify({
      type: "text",
      part: {
        type: "text",
        text: "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
      },
    })

    const directory = await mkdtemp(join(tmpdir(), "opencode-review-cmd-"))
    const markerPath = join(directory, "parent-edited")
    const binaryPath = join(directory, "opencode")
    try {
      await writeFile(
        binaryPath,
        [
          "#!/bin/sh",
          `printf '%s\\n' '{"type":"step_start","sessionID":"ses_parent"}'`,
          `printf '%s\\n' '${toolUse.replace(/'/g, `'\\''`)}'`,
          // Parent resume would apply findings; kill must stop this before edits.
          "sleep 5",
          `printf '%s\\n' '${parentFixed.replace(/'/g, `'\\''`)}'`,
          `echo parent-edited > "${markerPath}"`,
          "",
        ].join("\n"),
      )
      await chmod(binaryPath, 0o700)

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* AgentBackend
          return yield* backend.continueTurn({
            sessionId: "ses_parent",
            cwd: process.cwd(),
            prompt: "Review uncommitted worktree changes.",
            model: "test/model",
            thinkingLevel: "test",
            command: "/review",
            timeout: "3 seconds",
          })
        }).pipe(
          Effect.provide(
            Opencode.layer({
              binary: binaryPath,
              keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
            }).pipe(Layer.provide(BunServices.layer)),
          ),
        ),
      )

      expect(result.sessionId).toBe("ses_parent")
      expect(result.assistantText).toBe(childText)
      expect(result.assistantText).toContain(
        "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium",
      )
      expect(result.assistantText).not.toContain(
        "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
      )
      await Bun.sleep(200)
      expect(await Bun.file(markerPath).exists()).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("returns the command task result when the process exits immediately after the nested task", async () => {
    const childText = "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: medium"
    const toolUse = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_parent",
      part: {
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: { command: "review" },
          output: `<task_result>\n${childText}\n</task_result>`,
        },
      },
    })
    const directory = await mkdtemp(join(tmpdir(), "opencode-review-cmd-"))
    const binaryPath = join(directory, "opencode")
    try {
      await writeFile(
        binaryPath,
        [
          "#!/bin/sh",
          `printf '%s\\n' '{"type":"step_start","sessionID":"ses_parent"}'`,
          `printf '%s\\n' '${toolUse.replace(/'/g, `'\\''`)}'`,
          "exit 0",
          "",
        ].join("\n"),
      )
      await chmod(binaryPath, 0o700)

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* AgentBackend
          return yield* backend.continueTurn({
            sessionId: "ses_parent",
            cwd: process.cwd(),
            prompt: "Review uncommitted worktree changes.",
            model: "test/model",
            thinkingLevel: "test",
            command: "/review",
            timeout: "3 seconds",
          })
        }).pipe(
          Effect.provide(
            Opencode.layer({
              binary: binaryPath,
              keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
            }).pipe(Layer.provide(BunServices.layer)),
          ),
        ),
      )

      expect(result).toEqual({
        sessionId: "ses_parent",
        assistantText: childText,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("does not fail the run when onSessionId fails", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_observer_fail"}'`,
        `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"ok"}}'`,
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(
            startTurn(binary, "2 seconds", () =>
              Effect.fail(new Error("observer boom") as never),
            ),
          ),
        ).resolves.toEqual({
          sessionId: "ses_observer_fail",
          assistantText: "ok",
        })
      },
    )
  })

  it("inspects models with thinking levels from verbose OpenCode output", async () => {
    await withExecutable(
      [
        'if [ "$1" = "models" ] && [ "$2" = "--verbose" ]; then',
        `  printf '%s\\n' 'xai/grok-4.5'`,
        `  printf '%s\\n' '{'`,
        `  printf '%s\\n' '  "variants": {'`,
        `  printf '%s\\n' '    "low": {},'`,
        `  printf '%s\\n' '    "medium": {},'`,
        `  printf '%s\\n' '    "high": {}'`,
        `  printf '%s\\n' '  }'`,
        `  printf '%s\\n' '}'`,
        `  printf '%s\\n' 'xai/empty-variants'`,
        `  printf '%s\\n' '{'`,
        `  printf '%s\\n' '  "variants": {}'`,
        `  printf '%s\\n' '}'`,
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.inspect({
              cwd: process.cwd(),
              timeout: "2 seconds",
            })
          }).pipe(
            Effect.provide(
              Opencode.layer({
                binary,
                keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
              }).pipe(Layer.provide(BunServices.layer)),
            ),
          ),
        )

        expect(result.backend).toEqual({
          id: "opencode",
          label: "OpenCode",
        })
        expect(result.models).toEqual([
          {
            id: "xai/grok-4.5",
            thinkingLevels: ["low", "medium", "high"],
          },
          {
            id: "xai/empty-variants",
            thinkingLevels: [],
          },
        ])
      },
    )
  })

  it("captures a full multi-provider verbose catalog beyond 64KB", async () => {
    const padding = "x".repeat(1200)
    const entries: string[] = []
    for (let index = 0; index < 55; index += 1) {
      entries.push(
        [
          `opencode/model-${index}`,
          "{",
          `  "id": "model-${index}",`,
          `  "padding": "${padding}",`,
          '  "variants": {',
          '    "low": {},',
          '    "medium": {},',
          '    "high": {}',
          "  }",
          "}",
        ].join("\n"),
      )
    }
    entries.push(
      [
        "xai/grok-4.5",
        "{",
        '  "id": "grok-4.5",',
        '  "variants": {',
        '    "low": {},',
        '    "medium": {},',
        '    "high": {}',
        "  }",
        "}",
      ].join("\n"),
    )
    const fullStdout = `${entries.join("\n")}\n`
    expect(Buffer.byteLength(fullStdout, "utf8")).toBeGreaterThan(64 * 1024)
    const expectedParsed = parseVerboseModelsOutput(fullStdout)
    expect(expectedParsed.length).toBe(56)
    expect(expectedParsed.at(-1)).toEqual({
      id: "xai/grok-4.5",
      variants: ["low", "medium", "high"],
    })

    const directory = await mkdtemp(join(tmpdir(), "opencode-effect-test-"))
    const fixturePath = join(directory, "models-verbose.txt")
    const binaryPath = join(directory, "opencode")
    try {
      await writeFile(fixturePath, fullStdout)
      await writeFile(
        binaryPath,
        [
          "#!/bin/sh",
          'if [ "$1" = "models" ] && [ "$2" = "--verbose" ]; then',
          `  cat "${fixturePath}"`,
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
      )
      await chmod(binaryPath, 0o700)

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* AgentBackend
          return yield* backend.inspect({
            cwd: process.cwd(),
            timeout: "5 seconds",
          })
        }).pipe(
          Effect.provide(
            Opencode.layer({
              binary: binaryPath,
              keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
            }).pipe(Layer.provide(BunServices.layer)),
          ),
        ),
      )

      expect(result.models).toEqual(
        expectedParsed.map((model) => ({
          id: model.id,
          thinkingLevels: model.variants,
        })),
      )
      expect(
        result.models.find((model) => model.id === "xai/grok-4.5"),
      ).toEqual({
        id: "xai/grok-4.5",
        thinkingLevels: ["low", "medium", "high"],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("fails when verbose models stdout is truncated mid-object", async () => {
    await withExecutable(
      [
        'if [ "$1" = "models" ] && [ "$2" = "--verbose" ]; then',
        `  printf '%s\\n' 'opencode/kimi-k2.5'`,
        `  printf '%s\\n' '{'`,
        `  printf '%s\\n' '  "variants": {'`,
        `  printf '%s\\n' '    "low": {}'`,
        "  exit 0",
        "fi",
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
          }).pipe(
            Effect.provide(
              Opencode.layer({
                binary,
                keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
              }).pipe(Layer.provide(BunServices.layer)),
            ),
            Effect.flip,
          ),
        )

        expect(error).toBeInstanceOf(AgentBackendMalformedOutputError)
        if (error instanceof AgentBackendMalformedOutputError) {
          expect(error.cwd).toBe(process.cwd())
          expect(error.byteLength).toBeGreaterThan(0)
        }
      },
    )
  })
})
