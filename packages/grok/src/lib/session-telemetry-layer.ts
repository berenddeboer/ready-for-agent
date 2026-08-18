import { Effect, Layer } from "effect"
import {
  type SessionTelemetry,
  SessionTelemetryProvider,
} from "@ready-for-agent/agent-backend"
import {
  GROK_BACKEND,
  type GrokSession,
  GrokSessionStore,
  GrokSessionStoreLive,
  type GrokSessionStoreOptions,
} from "./session-store.js"

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
 * Expose Grok Build on-disk Session Telemetry and Agent Turn Tail.
 * Reads `$GROK_HOME/sessions/<cwd-encoded>/<session-id>/` (summary.json +
 * a bounded reverse read of updates.jsonl for the tail).
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
        getTail: (sessionId) => store.getTail(sessionId),
      })
    }),
  ).pipe(Layer.provide(storeLayer))

  return Layer.merge(storeLayer, providerLayer)
}
