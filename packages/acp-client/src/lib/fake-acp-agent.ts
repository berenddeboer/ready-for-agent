import { Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import * as acp from "@agentclientprotocol/sdk"
import { readableToWebBytes } from "./web-streams.js"

export const fakeAcpAgentPath = fileURLToPath(import.meta.url)

export const FAKE_ACP_ENV = {
  requireAuth: "FAKE_ACP_REQUIRE_AUTH",
  authMethodId: "FAKE_ACP_AUTH_METHOD_ID",
  assistantText: "FAKE_ACP_ASSISTANT_TEXT",
  echoPrompt: "FAKE_ACP_ECHO_PROMPT",
  reportedSessionId: "FAKE_ACP_REPORTED_SESSION_ID",
  alsoSessionId: "FAKE_ACP_ALSO_SESSION_ID",
  resumeFail: "FAKE_ACP_RESUME_FAIL",
  loadFail: "FAKE_ACP_LOAD_FAIL",
  promptDelayMs: "FAKE_ACP_PROMPT_DELAY_MS",
} as const

const defaultAssistantText = "hello from fake agent"
const defaultAuthMethodId = "token"

const envFlag = (name: string): boolean => process.env[name] === "1"

const promptText = (params: acp.PromptRequest): string => {
  const parts: string[] = []
  for (const block of params.prompt) {
    if (block.type === "text") {
      parts.push(block.text)
    }
  }
  return parts.join("")
}

const assistantText = (params: acp.PromptRequest): string => {
  if (envFlag(FAKE_ACP_ENV.echoPrompt)) {
    return promptText(params)
  }
  return process.env[FAKE_ACP_ENV.assistantText] ?? defaultAssistantText
}

const reportedSessionId = (requested: string): string =>
  process.env[FAKE_ACP_ENV.reportedSessionId] ?? requested

const authMethodId = (): string =>
  process.env[FAKE_ACP_ENV.authMethodId] ?? defaultAuthMethodId

const promptDelayMs = (): number => {
  const raw = process.env[FAKE_ACP_ENV.promptDelayMs]
  if (raw === undefined) return 0
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

const textChunks = (text: string): readonly [string, string] => {
  const mid = Math.max(1, Math.floor(text.length / 2))
  return [text.slice(0, mid), text.slice(mid)]
}

const optionalMeta = (
  meta: { readonly [key: string]: unknown } | null | undefined,
): { readonly _meta?: { readonly [key: string]: unknown } } =>
  meta == null ? {} : { _meta: meta }

type AgentSession = {
  pendingPrompt: AbortController | null
}

class FakeAcpAgent {
  private readonly sessions = new Map<string, AgentSession>()
  private authenticated = !envFlag(FAKE_ACP_ENV.requireAuth)

  initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return Promise.resolve({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          resume: {},
        },
      },
      agentInfo: {
        name: "fake-acp-agent",
        version: "0.0.1",
      },
      authMethods: envFlag(FAKE_ACP_ENV.requireAuth)
        ? [
            {
              id: authMethodId(),
              name: "Token",
            },
          ]
        : [],
      ...optionalMeta(params._meta),
    })
  }

  authenticate(
    params: acp.AuthenticateRequest,
  ): Promise<acp.AuthenticateResponse> {
    if (params.methodId !== authMethodId()) {
      throw acp.RequestError.invalidParams(
        { methodId: params.methodId },
        "Unknown authentication method",
      )
    }
    this.authenticated = true
    return Promise.resolve({
      ...optionalMeta(params._meta),
    })
  }

  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.requireAuth()
    const sessionId = crypto.randomUUID()
    this.sessions.set(sessionId, { pendingPrompt: null })
    return Promise.resolve({
      sessionId,
      ...optionalMeta(params._meta),
    })
  }

  loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    this.requireAuth()
    if (envFlag(FAKE_ACP_ENV.loadFail)) {
      throw acp.RequestError.invalidParams(
        { sessionId: params.sessionId },
        "Failed to load session",
      )
    }
    this.sessions.set(params.sessionId, { pendingPrompt: null })
    return client
      .notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "old history",
          },
        },
      })
      .then(() => ({
        ...optionalMeta(params._meta),
      }))
  }

  resumeSession(
    params: acp.ResumeSessionRequest,
  ): Promise<acp.ResumeSessionResponse> {
    this.requireAuth()
    if (envFlag(FAKE_ACP_ENV.resumeFail)) {
      throw acp.RequestError.invalidParams(
        { sessionId: params.sessionId },
        "Failed to resume session",
      )
    }
    this.sessions.set(params.sessionId, { pendingPrompt: null })
    return Promise.resolve({
      ...optionalMeta(params._meta),
    })
  }

  async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
  ): Promise<acp.PromptResponse> {
    this.requireAuth()
    const session = this.sessions.get(params.sessionId)
    if (session === undefined) {
      throw acp.RequestError.invalidParams(
        { sessionId: params.sessionId },
        "Session not found",
      )
    }

    session.pendingPrompt?.abort()
    session.pendingPrompt = new AbortController()
    const signal = session.pendingPrompt.signal

    try {
      await delay(promptDelayMs(), signal)
      const sessionId = reportedSessionId(params.sessionId)
      for (const chunk of textChunks(assistantText(params))) {
        if (signal.aborted) {
          return { stopReason: "cancelled", ...optionalMeta(params._meta) }
        }
        await client.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: chunk,
            },
          },
        })
      }
      const extraSessionId = process.env[FAKE_ACP_ENV.alsoSessionId]
      if (extraSessionId !== undefined && extraSessionId.length > 0) {
        await client.notify(acp.methods.client.session.update, {
          sessionId: extraSessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "subagent",
            },
          },
        })
      }
    } catch {
      return { stopReason: "cancelled", ...optionalMeta(params._meta) }
    } finally {
      session.pendingPrompt = null
    }

    if (signal.aborted) {
      return { stopReason: "cancelled", ...optionalMeta(params._meta) }
    }

    return { stopReason: "end_turn", ...optionalMeta(params._meta) }
  }

  cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort()
    return Promise.resolve()
  }

  private requireAuth(): void {
    if (!this.authenticated) {
      throw acp.RequestError.authRequired(undefined, "Authentication required")
    }
  }
}

const delay = (ms: number, signal: AbortSignal): Promise<void> => {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error("cancelled"))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

export const runFakeAcpAgent = (): void => {
  const input = Writable.toWeb(process.stdout)
  const output = readableToWebBytes(process.stdin)
  const stream = acp.ndJsonStream(input, output)
  const agent = new FakeAcpAgent()

  acp
    .agent({ name: "fake-acp-agent" })
    .onRequest(acp.methods.agent.initialize, (ctx) =>
      agent.initialize(ctx.params),
    )
    .onRequest(acp.methods.agent.authenticate, (ctx) =>
      agent.authenticate(ctx.params),
    )
    .onRequest(acp.methods.agent.session.new, (ctx) =>
      agent.newSession(ctx.params),
    )
    .onRequest(acp.methods.agent.session.load, (ctx) =>
      agent.loadSession(ctx.params, ctx.client),
    )
    .onRequest(acp.methods.agent.session.resume, (ctx) =>
      agent.resumeSession(ctx.params),
    )
    .onRequest(acp.methods.agent.session.prompt, (ctx) =>
      agent.prompt(ctx.params, ctx.client),
    )
    .onNotification(acp.methods.agent.session.cancel, (ctx) =>
      agent.cancel(ctx.params),
    )
    .connect(stream)
}

if (import.meta.main) {
  runFakeAcpAgent()
}
