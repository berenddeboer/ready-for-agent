import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  type SessionTelemetry,
  SessionTelemetryProvider,
} from "@ready-for-agent/agent-backend"
import {
  type GrokSession,
  GrokSessionStore,
  GrokSessionStoreLive,
  type GrokSessionStoreOptions,
} from "./session-store.js"

const GROK_BACKEND = {
  id: AGENT_BACKEND_IDS.grok,
  label: "Grok Build",
} as const

const toSessionTelemetry = (session: GrokSession): SessionTelemetry => ({
  id: session.id,
  availability: session.availability,
  backend: GROK_BACKEND,
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
 * Expose Grok Build on-disk Session Telemetry through the generic provider.
 * Reads `$GROK_HOME/sessions/<cwd-encoded>/<session-id>/` (summary.json + updates.jsonl).
 */
export const GrokSessionTelemetryLive = (
  options: GrokSessionStoreOptions = {},
): Layer.Layer<SessionTelemetryProvider | GrokSessionStore> => {
  const storeLayer = GrokSessionStoreLive(options)
  const providerLayer = Layer.effect(
    SessionTelemetryProvider,
    Effect.gen(function* () {
      const store = yield* GrokSessionStore
      return SessionTelemetryProvider.of({
        getSession: (sessionId) =>
          store.getSession(sessionId).pipe(Effect.map(toSessionTelemetry)),
      })
    }),
  ).pipe(Layer.provide(storeLayer))

  return Layer.merge(storeLayer, providerLayer)
}
