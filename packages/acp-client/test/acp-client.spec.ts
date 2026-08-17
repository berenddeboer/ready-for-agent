import { Effect, Fiber } from "effect"
import {
  AcpClient,
  type AcpConnection,
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
})
