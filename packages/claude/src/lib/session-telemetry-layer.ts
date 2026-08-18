import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  type SessionTelemetry,
  SessionTelemetryProvider,
} from "@ready-for-agent/agent-backend"
import {
  type ClaudeSession,
  ClaudeSessionStore,
  ClaudeSessionStoreLive,
  type ClaudeSessionStoreOptions,
} from "./session-store.js"

const CLAUDE_BACKEND = {
  id: AGENT_BACKEND_IDS.claude,
  label: "Claude Code",
} as const

const toSessionTelemetry = (session: ClaudeSession): SessionTelemetry => ({
  id: session.id,
  availability: session.availability,
  backend: CLAUDE_BACKEND,
  model:
    session.model === null
      ? null
      : {
          providerId: session.model.providerId,
          id: session.model.id,
          thinkingLevel: session.model.thinkingLevel,
        },
  tokens: session.tokens,
  cost: session.cost,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

/**
 * Expose Claude Code's file-backed transcript Session Telemetry through the
 * generic provider. The backend label remains Claude Code in Bedrock mode;
 * the transcript model supplies the effective provider identity.
 */
export const ClaudeSessionTelemetryLive = (
  options: ClaudeSessionStoreOptions = {},
): Layer.Layer<SessionTelemetryProvider | ClaudeSessionStore> => {
  const storeLayer = ClaudeSessionStoreLive(options)
  const providerLayer = Layer.effect(
    SessionTelemetryProvider,
    Effect.gen(function* () {
      const store = yield* ClaudeSessionStore
      return SessionTelemetryProvider.of({
        getSession: (sessionId) =>
          store.getSession(sessionId).pipe(Effect.map(toSessionTelemetry)),
        getTail: (sessionId) => store.getTail(sessionId),
      })
    }),
  ).pipe(Layer.provide(storeLayer))

  return Layer.merge(storeLayer, providerLayer)
}
