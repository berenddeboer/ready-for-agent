import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import {
  AcpClient,
  type AcpConnection,
  AcpProcessExitError,
  AcpProtocolError,
  AcpSessionId,
  AcpSpawnError,
  FAKE_ACP_ENV,
  fakeAcpAgentPath,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
)

const connect = (env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const client = yield* AcpClient
    return yield* client.connect({
      command: process.execPath,
      args: [fakeAcpAgentPath],
      cwd: process.cwd(),
      env: { ...inheritedEnv, ...env },
    })
  })

const run = <A, E>(
  body: (connection: AcpConnection) => Effect.Effect<A, E>,
  env: Readonly<Record<string, string>> = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connect(env)
        return yield* body(connection)
      }),
    ).pipe(Effect.provide(AcpClient.layer)),
  )

describe("Effect ACP client", () => {
  it("returns the Session ID and streamed assistant text after a new-session prompt", async () => {
    const result = await run((connection) =>
      Effect.gen(function* () {
        yield* connection.initialize()
        const session = yield* connection.newSession({ cwd: process.cwd() })
        const prompt = yield* connection.prompt({
          sessionId: session.sessionId,
          prompt: "hello",
        })
        return { sessionId: session.sessionId, prompt }
      }),
    )

    expect(result.prompt.sessionId).toBe(result.sessionId)
    expect(result.prompt.assistantText).toBe("hello from fake agent")
    expect(result.prompt.stopReason).toBe("end_turn")
  })

  it("resumes a Session ID and returns assistant text", async () => {
    const sessionId = AcpSessionId.make("sess_resume_1")
    const result = await run((connection) =>
      Effect.gen(function* () {
        yield* connection.initialize()
        const session = yield* connection.resumeSession({
          sessionId,
          cwd: process.cwd(),
        })
        return yield* connection.prompt({
          sessionId: session.sessionId,
          prompt: "continue",
        })
      }),
    )

    expect(result.sessionId).toBe(sessionId)
    expect(result.assistantText).toBe("hello from fake agent")
    expect(result.stopReason).toBe("end_turn")
  })

  it("loads a Session ID without folding replayed history into assistant text", async () => {
    const sessionId = AcpSessionId.make("sess_load_1")
    const result = await run((connection) =>
      Effect.gen(function* () {
        yield* connection.initialize()
        const session = yield* connection.loadSession({
          sessionId,
          cwd: process.cwd(),
        })
        return yield* connection.prompt({
          sessionId: session.sessionId,
          prompt: "continue",
        })
      }),
    )

    expect(result.sessionId).toBe(sessionId)
    expect(result.assistantText).toBe("hello from fake agent")
    expect(result.stopReason).toBe("end_turn")
  })

  it("authenticates when the agent advertises a method, then completes a prompt", async () => {
    const result = await run(
      (connection) =>
        Effect.gen(function* () {
          const initialized = yield* connection.initialize()
          yield* connection.authenticate({
            methodId: initialized.authMethods[0]!.id,
          })
          const session = yield* connection.newSession({ cwd: process.cwd() })
          return yield* connection.prompt({
            sessionId: session.sessionId,
            prompt: "hello",
          })
        }),
      { [FAKE_ACP_ENV.requireAuth]: "1" },
    )

    expect(result.assistantText).toBe("hello from fake agent")
    expect(result.stopReason).toBe("end_turn")
  })

  it("cancels an in-flight prompt", async () => {
    const result = await run(
      (connection) =>
        Effect.gen(function* () {
          yield* connection.initialize()
          const session = yield* connection.newSession({ cwd: process.cwd() })
          const fiber = yield* Effect.forkChild(
            connection.prompt({
              sessionId: session.sessionId,
              prompt: "hello",
            }),
          )
          yield* Effect.sleep("50 millis")
          yield* connection.cancel({ sessionId: session.sessionId })
          return yield* Fiber.join(fiber)
        }),
      { [FAKE_ACP_ENV.promptDelayMs]: "2000" },
    )

    expect(result.stopReason).toBe("cancelled")
  })

  it("passes opaque _meta through initialize, session, and prompt", async () => {
    const meta = { customKey: "custom-value", nested: { n: 1 } }
    const result = await run((connection) =>
      Effect.gen(function* () {
        const initialized = yield* connection.initialize({ _meta: meta })
        const session = yield* connection.newSession({
          cwd: process.cwd(),
          _meta: meta,
        })
        const prompt = yield* connection.prompt({
          sessionId: session.sessionId,
          prompt: "hello",
          _meta: meta,
        })
        return { initialized, session, prompt }
      }),
    )

    expect(result.initialized._meta).toEqual(meta)
    expect(result.session._meta).toEqual(meta)
    expect(result.prompt._meta).toEqual(meta)
  })

  it("returns the Session ID the agent reported on prompt chunks", async () => {
    const requested = AcpSessionId.make("sess_requested")
    const reported = "sess_reported"
    const result = await run(
      (connection) =>
        Effect.gen(function* () {
          yield* connection.initialize()
          yield* connection.resumeSession({
            sessionId: requested,
            cwd: process.cwd(),
          })
          return yield* connection.prompt({
            sessionId: requested,
            prompt: "continue",
          })
        }),
      { [FAKE_ACP_ENV.reportedSessionId]: reported },
    )

    expect(result.sessionId).toBe(reported)
    expect(result.assistantText).toBe("")
  })

  it("keeps the requested Session ID when a later chunk uses another Session", async () => {
    const requested = AcpSessionId.make("sess_requested")
    const result = await run(
      (connection) =>
        Effect.gen(function* () {
          yield* connection.initialize()
          yield* connection.resumeSession({
            sessionId: requested,
            cwd: process.cwd(),
          })
          return yield* connection.prompt({
            sessionId: requested,
            prompt: "continue",
          })
        }),
      { [FAKE_ACP_ENV.alsoSessionId]: "sess_subagent" },
    )

    expect(result.sessionId).toBe(requested)
    expect(result.assistantText).toBe("hello from fake agent")
  })

  it("fails with a tagged protocol error when resume is refused", async () => {
    const result = await run(
      (connection) =>
        Effect.gen(function* () {
          yield* connection.initialize()
          return yield* connection
            .resumeSession({
              sessionId: AcpSessionId.make("sess_missing"),
              cwd: process.cwd(),
            })
            .pipe(Effect.flip)
        }),
      { [FAKE_ACP_ENV.resumeFail]: "1" },
    )

    expect(result).toBeInstanceOf(AcpProtocolError)
    expect(result.method).toBe("session/resume")
  })

  it("fails with a tagged spawn error when the agent command is missing", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* AcpClient
          return yield* client
            .connect({
              command: "/nonexistent/acp-agent-binary",
              cwd: process.cwd(),
            })
            .pipe(Effect.flip)
        }),
      ).pipe(Effect.provide(AcpClient.layer)),
    )

    expect(result).toBeInstanceOf(AcpSpawnError)
  })

  const withScript = async (
    source: string,
    use: (path: string) => Promise<void>,
  ) => {
    const directory = await mkdtemp(join(tmpdir(), "acp-stderr-"))
    const path = join(directory, "agent.mjs")
    try {
      await writeFile(path, source)
      await use(path)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  const initializeError = (command: string, args: readonly string[] = []) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* AcpClient
          const connection = yield* client.connect({
            command,
            args: [...args],
            cwd: process.cwd(),
            env: inheritedEnv,
          })
          return yield* connection.initialize()
        }),
      ).pipe(Effect.provide(AcpClient.layer), Effect.flip),
    )

  const MISE_TRUST_STDERR = [
    "mise ERROR error parsing config file: ~/src/ready-for-agent/12-wi-01M54A0TQ8D6P1EVWM82H8XK91/mise.toml",
    "mise ERROR Config files in ~/src/ready-for-agent/12-wi-01M54A0TQ8D6P1EVWM82H8XK91/mise.toml are not trusted.",
    "Trust them with `mise trust`.",
  ].join("\n")

  it("keeps a mise trust error written immediately before exit", async () => {
    const source = [
      'import { writeSync } from "node:fs"',
      `writeSync(2, ${JSON.stringify(`${MISE_TRUST_STDERR}\n`)})`,
      "process.exit(1)",
      "",
    ].join("\n")
    await withScript(source, async (path) => {
      const error = await initializeError(process.execPath, [path])
      expect(error).toBeInstanceOf(AcpProcessExitError)
      if (!(error instanceof AcpProcessExitError)) {
        throw new Error("Expected ACP process exit")
      }
      expect(error.exitCode).toBe(1)
      expect(error.command).toBe(process.execPath)
      expect(error.message).toContain("before initialize completed")
      expect(error.message).toContain(process.execPath)
      expect(error.message).toContain("exit 1")
      expect(error.message).toContain("are not trusted")
      expect(error.message).toContain("mise trust")
      expect(error.message.length).toBeLessThanOrEqual(500)
    })
  })

  it("bounds chunked stderr and keeps the diagnostic written just before exit", async () => {
    const source = [
      'import { writeSync } from "node:fs"',
      'writeSync(2, "PREFIX-MARKER\\n")',
      "const chunk = Buffer.alloc(64 * 1024, 0x78)",
      "writeSync(2, chunk)",
      "writeSync(2, chunk)",
      'writeSync(2, "\\nTAIL-MARKER Trust them with `mise trust`.\\n")',
      "process.exit(1)",
      "",
    ].join("\n")
    await withScript(source, async (path) => {
      const error = await initializeError(process.execPath, [path])
      expect(error).toBeInstanceOf(AcpProcessExitError)
      if (!(error instanceof AcpProcessExitError)) {
        throw new Error("Expected ACP process exit")
      }
      expect(error.exitCode).toBe(1)
      expect(error.message).toContain("TAIL-MARKER")
      expect(error.message).toContain("mise trust")
      expect(error.message).toContain("exit 1")
      expect(error.message).not.toContain("PREFIX-MARKER")
      expect(error.message.length).toBeLessThanOrEqual(500)
    })
  })

  it("redacts a credential in stderr before the exit message is returned", async () => {
    const secret = "ghp_this_must_never_appear_in_exit_message"
    const source = [
      'import { writeSync } from "node:fs"',
      `writeSync(2, ${JSON.stringify(`not trusted ${secret}\nTrust them with \`mise trust\`.\n`)})`,
      "process.exit(1)",
      "",
    ].join("\n")
    await withScript(source, async (path) => {
      const error = await initializeError(process.execPath, [path])
      expect(error).toBeInstanceOf(AcpProcessExitError)
      if (!(error instanceof AcpProcessExitError)) {
        throw new Error("Expected ACP process exit")
      }
      expect(error.message).toContain("[redacted]")
      expect(error.message).toContain("mise trust")
      expect(error.message).not.toContain(secret)
      expect(error.message).not.toMatch(/ghp_[A-Za-z0-9_]+/)
    })
  })

  it("keeps the method-specific error when stderr is empty", async () => {
    const source = ["process.exit(1)", ""].join("\n")
    await withScript(source, async (path) => {
      const error = await initializeError(process.execPath, [path])
      expect(error).toBeInstanceOf(AcpProcessExitError)
      if (!(error instanceof AcpProcessExitError)) {
        throw new Error("Expected ACP process exit")
      }
      expect(error.exitCode).toBe(1)
      expect(error.command).toBe(process.execPath)
      expect(error.message).toBe("ACP agent exited before initialize completed")
    })
  })

  it("completes a prompt when the agent writes stderr", async () => {
    const result = await run(
      (connection) =>
        Effect.gen(function* () {
          yield* connection.initialize()
          const session = yield* connection.newSession({ cwd: process.cwd() })
          return yield* connection.prompt({
            sessionId: session.sessionId,
            prompt: "hello",
          })
        }),
      { [FAKE_ACP_ENV.stderrLine]: "harmless startup warning" },
    )

    expect(result.assistantText).toBe("hello from fake agent")
    expect(result.stopReason).toBe("end_turn")
  })
})
