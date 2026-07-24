import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  type SessionTelemetry,
  SessionTelemetryProvider,
} from "@ready-for-agent/agent-backend"
import {
  type OpencodeSession,
  OpencodeSessionStore,
  OpencodeSessionStoreLive,
  type OpencodeSessionStoreOptions,
} from "./session-store.js"

const OPENCODE_BACKEND = {
  id: AGENT_BACKEND_IDS.opencode,
  label: "OpenCode",
} as const

const toSessionTelemetry = (session: OpencodeSession): SessionTelemetry => ({
  id: session.id,
  availability: session.availability,
  backend: OPENCODE_BACKEND,
  model:
    session.model === null
      ? null
      : {
          providerId: session.model.providerId,
          id: session.model.id,
          thinkingLevel: session.model.variant,
        },
  tokens: session.tokens,
  cost: session.cost,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

/**
 * Expose OpenCode live SQLite Session Telemetry through the generic provider.
 */
export const OpencodeSessionTelemetryLive = (
  options: OpencodeSessionStoreOptions = {},
): Layer.Layer<SessionTelemetryProvider | OpencodeSessionStore> => {
  const storeLayer = OpencodeSessionStoreLive(options)
  const providerLayer = Layer.effect(
    SessionTelemetryProvider,
    Effect.gen(function* () {
      const store = yield* OpencodeSessionStore
      return SessionTelemetryProvider.of({
        getSession: (sessionId) =>
          store.getSession(sessionId).pipe(Effect.map(toSessionTelemetry)),
      })
    }),
  ).pipe(Layer.provide(storeLayer))

  return Layer.merge(storeLayer, providerLayer)
}
