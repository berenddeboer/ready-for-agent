import { mkdtempSync, rmSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import {
  AgentBackend,
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  AgentBackendStartupTimeoutError,
  AgentBackendTimeoutError,
  type OnSessionId,
  PROMPT_ARGV_BYTE_LIMIT,
} from "@ready-for-agent/agent-backend"
import { Opencode, parseVerboseModelsOutput } from "../src/index.js"
import { Database } from "bun:sqlite"
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
  it("strips Forge token variables from vault-enabled Agent Turns", async () => {
    await withExecutable(
      [
        '[ -z "$GITHUB_TOKEN" ] || exit 8',
        '[ -z "$GITLAB_TOKEN" ] || exit 9',
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_sanitized"}'`,
      ].join("\n"),
      async (binary) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.startTurn({
              cwd: process.cwd(),
              prompt: "test",
              model: "test/model",
              thinkingLevel: "test",
              timeout: "2 seconds",
            })
          }).pipe(
            Effect.provide(
              Opencode.layer({
                binary,
                keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
                environment: {
                  GITHUB_TOKEN: "github-token",
                  GITLAB_TOKEN: "gitlab-token",
                },
              }).pipe(Layer.provide(BunServices.layer)),
            ),
          ),
        )

        expect(result.sessionId).toBe("ses_sanitized")
      },
    )
  })

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

  it("sends a large single-line prompt through stdin instead of argv", async () => {
    // Single-line and past the argv byte limit: on argv this spawn fails with
    // an opaque platform error rather than reaching the CLI at all.
    const prompt = `Fix ${"x".repeat(PROMPT_ARGV_BYTE_LIMIT)}`
    await withExecutable(
      [
        "input=$(cat)",
        `[ \${#input} -eq ${prompt.length} ] || exit 9`,
        'case "$input" in "Fix x"*) ;; *) exit 10 ;; esac',
        'case " $* " in *" -- "*) exit 11 ;; esac',
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_large"}'`,
      ].join("\n"),
      async (binary) => {
        await expect(
          Effect.runPromise(startTurn(binary, "10 seconds", undefined, prompt)),
        ).resolves.toEqual({
          sessionId: "ses_large",
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
          AgentBackendExitError.new({
            exitCode: 7,
            cwd: process.cwd(),
            sessionId: "ses_failed",
            message: "OpenCode failed with exit code 7",
          }),
        )
      },
    )
  })

  it("classifies a retryable provider error observed before a non-zero exit", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_retry"}'`,
        `printf '%s\\n' '{"type":"error","sessionID":"ses_retry","error":{"name":"APIError","data":{"message":"Overloaded","statusCode":503,"isRetryable":true}}}'`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toEqual(
          AgentBackendExitError.new({
            exitCode: 1,
            cwd: process.cwd(),
            sessionId: "ses_retry",
            classification: "retryable_provider_error",
            message: "OpenCode failed with exit code 1",
          }),
        )
      },
    )
  })

  it("classifies a length-limit truncation observed before a non-zero exit", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_length"}'`,
        `printf '%s\\n' '{"type":"error","sessionID":"ses_length","error":{"name":"MessageOutputLengthError","data":{}}}'`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toEqual(
          AgentBackendExitError.new({
            exitCode: 1,
            cwd: process.cwd(),
            sessionId: "ses_length",
            classification: "length_limit_truncation",
            message: "OpenCode failed with exit code 1",
          }),
        )
      },
    )
  })

  it("classifies a provider auth error observed before a non-zero exit", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_auth"}'`,
        `printf '%s\\n' '{"type":"error","sessionID":"ses_auth","error":{"name":"ProviderAuthError","data":{"providerID":"anthropic","message":"Not authenticated"}}}'`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toEqual(
          AgentBackendExitError.new({
            exitCode: 1,
            cwd: process.cwd(),
            sessionId: "ses_auth",
            classification: "terminal_auth_error",
            message: "OpenCode failed with exit code 1",
          }),
        )
      },
    )
  })

  it("falls back to a generic exit error for an unrecognized error payload", async () => {
    await withExecutable(
      [
        `printf '%s\\n' '{"type":"step_start","sessionID":"ses_unknown"}'`,
        `printf '%s\\n' '{"type":"error","sessionID":"ses_unknown","error":{"name":"UnknownError","data":{"message":"Unexpected server error."}}}'`,
        "exit 1",
      ].join("\n"),
      async (binary) => {
        const error = await Effect.runPromise(
          startTurn(binary, "2 seconds").pipe(Effect.flip),
        )
        expect(error).toEqual(
          AgentBackendExitError.new({
            exitCode: 1,
            cwd: process.cwd(),
            sessionId: "ses_unknown",
            message: "OpenCode failed with exit code 1",
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

  it("re-asserts the configured Agent Model after startTurn reports a Session ID", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "opencode-start-model-"))
    const dbPath = join(fixtureDir, "opencode.db")
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        model text,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      )
    `)
    db.query(
      `INSERT INTO session (id, model, time_created, time_updated) VALUES (?, ?, ?, ?)`,
    ).run(
      "ses_first",
      JSON.stringify({
        id: "gpt-5.6-sol",
        providerID: "azure",
        variant: null,
      }),
      Date.now(),
      Date.now(),
    )
    db.close()

    try {
      await withExecutable(
        [
          `printf '%s\\n' '{"type":"step_start","sessionID":"ses_first"}'`,
          "sleep 0.4",
          `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"done"}}'`,
        ].join("\n"),
        async (binary) => {
          await Effect.runPromise(
            Effect.gen(function* () {
              const backend = yield* AgentBackend
              return yield* backend.startTurn({
                cwd: process.cwd(),
                prompt: "test",
                model: "amazon-bedrock/au.anthropic.claude-sonnet-5",
                thinkingLevel: "high",
                timeout: "5 seconds",
              })
            }).pipe(
              Effect.provide(
                Opencode.layer({
                  binary,
                  keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
                  // Production first Build does not inject a DB path; the
                  // observer must locate OpenCode's session store via rules
                  // (OPENCODE_DB / data dir), not only a startup-probe cache.
                  environment: { OPENCODE_DB: dbPath },
                }).pipe(Layer.provide(BunServices.layer)),
              ),
            ),
          )

          const live = new Database(dbPath, { readonly: true })
          const row = live
            .query(`SELECT model FROM session WHERE id = ?`)
            .get("ses_first") as { readonly model: string }
          live.close()
          expect(JSON.parse(row.model)).toEqual({
            id: "au.anthropic.claude-sonnet-5",
            providerID: "amazon-bedrock",
            variant: "high",
          })
        },
      )
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
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

  it("completes a /review turn when parent JSONL is silent past startup while a task subagent is active", async () => {
    // Regression for #852: OpenCode persists the nested review task immediately
    // but the outer JSONL stream stays quiet until the child finishes. The
    // startup window must not treat that as a hang.
    const childText = "READY_FOR_AGENT_RESULT: REVIEW_CLEAN"
    const toolUse = JSON.stringify({
      type: "tool_use",
      sessionID: "ses_review_parent",
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

    const fixtureDir = mkdtempSync(join(tmpdir(), "opencode-review-startup-"))
    const dbPath = join(fixtureDir, "opencode.db")
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL DEFAULT 'proj',
        parent_id text,
        slug text NOT NULL DEFAULT 'slug',
        directory text NOT NULL DEFAULT '/tmp',
        title text NOT NULL DEFAULT 'title',
        version text NOT NULL DEFAULT '1',
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      );
      CREATE TABLE part (
        id text PRIMARY KEY,
        message_id text NOT NULL DEFAULT 'msg',
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `)
    const parentCreated = Date.now() - 60_000
    db.query(
      `INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`,
    ).run("ses_review_parent", parentCreated, parentCreated)
    db.close()

    const directory = await mkdtemp(join(tmpdir(), "opencode-review-silent-"))
    const binaryPath = join(directory, "opencode")
    try {
      await writeFile(
        binaryPath,
        [
          "#!/bin/sh",
          // Parent stream silent past the startup window, then emits the
          // nested task result — matching real OpenCode /review behaviour.
          // Window is deliberately wider than poll/seed slack to avoid flakes.
          "sleep 0.8",
          `printf '%s\\n' '${toolUse.replace(/'/g, `'\\''`)}'`,
          "exit 0",
          "",
        ].join("\n"),
      )
      await chmod(binaryPath, 0o700)

      // Seed child-session activity shortly after spawn so the OpenCode
      // adapter's observeStartup probe disarms the startup watchdog.
      const seedChild = async () => {
        await Bun.sleep(40)
        const live = new Database(dbPath)
        const now = Date.now()
        live
          .query(
            `INSERT INTO session (id, parent_id, time_created, time_updated)
             VALUES (?, ?, ?, ?)`,
          )
          .run("ses_review_child", "ses_review_parent", now, now)
        live.close()
      }
      void seedChild()

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* AgentBackend
          return yield* backend.continueTurn({
            sessionId: "ses_review_parent",
            cwd: process.cwd(),
            prompt: "Review uncommitted worktree changes.",
            model: "test/model",
            thinkingLevel: "test",
            command: "/review",
            timeout: "5 seconds",
          })
        }).pipe(
          Effect.provide(
            Opencode.layer({
              binary: binaryPath,
              keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
              startupActivityDbPath: dbPath,
              // Past seed (40ms) and default poll (100ms); before parent stdout.
              startupTimeout: "500 millis",
            }).pipe(Layer.provide(BunServices.layer)),
          ),
        ),
      )

      expect(result).toEqual({
        sessionId: "ses_review_parent",
        assistantText: childText,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it("still fails startup when a known session has no task subagent activity", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "opencode-review-hang-"))
    const dbPath = join(fixtureDir, "opencode.db")
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        project_id text NOT NULL DEFAULT 'proj',
        parent_id text,
        slug text NOT NULL DEFAULT 'slug',
        directory text NOT NULL DEFAULT '/tmp',
        title text NOT NULL DEFAULT 'title',
        version text NOT NULL DEFAULT '1',
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      );
      CREATE TABLE part (
        id text PRIMARY KEY,
        message_id text NOT NULL DEFAULT 'msg',
        session_id text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        data text NOT NULL
      );
    `)
    const parentCreated = Date.now() - 60_000
    db.query(
      `INSERT INTO session (id, time_created, time_updated) VALUES (?, ?, ?)`,
    ).run("ses_hang_parent", parentCreated, parentCreated)
    db.close()

    await withExecutable("sleep 100", async (binary) => {
      try {
        const error = await Effect.runPromise(
          Effect.gen(function* () {
            const backend = yield* AgentBackend
            return yield* backend.continueTurn({
              sessionId: "ses_hang_parent",
              cwd: process.cwd(),
              prompt: "Review uncommitted worktree changes.",
              model: "test/model",
              thinkingLevel: "test",
              command: "/review",
              timeout: "30 seconds",
            })
          }).pipe(
            Effect.provide(
              Opencode.layer({
                binary,
                keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
                startupActivityDbPath: dbPath,
                startupTimeout: "200 millis",
              }).pipe(Layer.provide(BunServices.layer)),
            ),
            Effect.flip,
          ),
        )
        expect(error).toEqual(
          new AgentBackendStartupTimeoutError({
            cwd: process.cwd(),
            startupTimeoutMs: 200,
            sessionId: "ses_hang_parent",
            model: "test/model",
            attemptCount: 2,
          }),
        )
      } finally {
        rmSync(fixtureDir, { recursive: true, force: true })
      }
    })
  })

  it("retries a silent known-Session continuation once and returns the second result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-retry-"))
    const counterFile = join(directory, "count")
    await writeFile(counterFile, "0")
    try {
      await withExecutable(
        [
          `count=$(($(cat "${counterFile}") + 1))`,
          `echo "$count" > "${counterFile}"`,
          `if [ "$count" -eq 1 ]; then sleep 100; fi`,
          `printf '%s\\n' '{"type":"step_start","sessionID":"ses_retry_parent"}'`,
          `printf '%s\\n' '{"type":"text","part":{"type":"text","text":"recovered"}}'`,
        ].join("\n"),
        async (binary) => {
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const backend = yield* AgentBackend
              return yield* backend.continueTurn({
                sessionId: "ses_retry_parent",
                cwd: process.cwd(),
                prompt: "Apply the findings.",
                model: "test/model",
                thinkingLevel: "test",
                timeout: "5 seconds",
              })
            }).pipe(
              Effect.provide(
                Opencode.layer({
                  binary,
                  keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
                  startupActivityDbPath: join(directory, "unused.db"),
                  startupTimeout: "200 millis",
                }).pipe(Layer.provide(BunServices.layer)),
              ),
            ),
          )
          expect(result).toEqual({
            sessionId: "ses_retry_parent",
            assistantText: "recovered",
          })
          expect((await Bun.file(counterFile).text()).trim()).toBe("2")
        },
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("does not retry a silent first turn without a durable Session ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-start-noretry-"))
    const counterFile = join(directory, "count")
    await writeFile(counterFile, "0")
    try {
      await withExecutable(
        [
          `count=$(($(cat "${counterFile}") + 1))`,
          `echo "$count" > "${counterFile}"`,
          "sleep 100",
        ].join("\n"),
        async (binary) => {
          const startedAt = Date.now()
          const error = await Effect.runPromise(
            Effect.gen(function* () {
              const backend = yield* AgentBackend
              return yield* backend.startTurn({
                cwd: process.cwd(),
                prompt: "Implement the issue.",
                model: "test/model",
                thinkingLevel: "test",
                timeout: "30 seconds",
              })
            }).pipe(
              Effect.provide(
                Opencode.layer({
                  binary,
                  keymaxxerMcpUrl: "http://127.0.0.1:6057/test/mcp",
                  startupTimeout: "200 millis",
                }).pipe(Layer.provide(BunServices.layer)),
              ),
              Effect.flip,
            ),
          )
          const elapsed = Date.now() - startedAt
          expect(error).toEqual(
            new AgentBackendStartupTimeoutError({
              cwd: process.cwd(),
              startupTimeoutMs: 200,
            }),
          )
          expect((await Bun.file(counterFile).text()).trim()).toBe("1")
          expect(elapsed).toBeLessThan(2_000)
        },
      )
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
        `  printf '%s\\n' '  "name": "Grok 4.5",'`,
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
            name: "Grok 4.5",
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

  it("surfaces a stderr-only readiness failure as the inspect exit reason", async () => {
    await withExecutable(
      [
        'if [ "$1" = "models" ] && [ "$2" = "--verbose" ]; then',
        "  printf 'Error: Configuration is invalid at /home/vscode/.config/opencode/opencode.jsonc\\n' >&2",
        "  printf '↳ Expected object | undefined, got [ … ] skills\\n' >&2",
        "  exit 1",
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

        expect(error).toBeInstanceOf(AgentBackendExitError)
        if (error instanceof AgentBackendExitError) {
          expect(error.exitCode).toBe(1)
          expect(error.message).toContain(
            "Configuration is invalid at /home/vscode/.config/opencode/opencode.jsonc",
          )
          expect(error.message).toContain("skills")
        }
      },
    )
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
