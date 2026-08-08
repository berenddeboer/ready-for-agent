import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  type SessionTelemetry,
  SessionTelemetryProvider,
} from "@ready-for-agent/agent-backend"
import {
  type CodexSession,
  CodexSessionStore,
  CodexSessionStoreLive,
  type CodexSessionStoreOptions,
} from "./session-store.js"

const CODEX_BACKEND = {
  id: AGENT_BACKEND_IDS.codex,
  label: "Codex Build",
} as const

const toSessionTelemetry = (session: CodexSession): SessionTelemetry => ({
  id: session.id,
  availability: session.availability,
  backend: CODEX_BACKEND,
  model: session.model,
  tokens: session.tokens,
  cost: session.cost,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

/** Expose Codex-owned rollout telemetry through the generic provider. */
export const CodexSessionTelemetryLive = (
  options: CodexSessionStoreOptions = {},
): Layer.Layer<SessionTelemetryProvider> => {
  const storeLayer = CodexSessionStoreLive(options)
  const providerLayer = Layer.effect(
    SessionTelemetryProvider,
    Effect.gen(function* () {
      const store = yield* CodexSessionStore
      return SessionTelemetryProvider.of({
        getSession: (sessionId) =>
          store.getSession(sessionId).pipe(Effect.map(toSessionTelemetry)),
      })
    }),
  ).pipe(Layer.provide(storeLayer))

  return providerLayer
}
