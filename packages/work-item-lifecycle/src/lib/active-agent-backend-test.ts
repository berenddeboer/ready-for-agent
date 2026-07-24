import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  type AgentBackendBlockedError,
  type AgentBackendRegistration,
  type AgentBackendStatus,
  type SessionTelemetry,
  getBuiltInAgentBackend,
  unsupportedSessionTelemetry,
} from "@ready-for-agent/agent-backend"

const opencodeRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.opencode)
if (opencodeRegistration === undefined) {
  throw new Error("OpenCode Agent Backend registration is missing")
}
const opencode = opencodeRegistration

const readyStatus = (
  registration: AgentBackendRegistration,
  models: AgentBackendStatus["models"] = [],
): AgentBackendStatus => ({
  selectedBackend: registration.descriptor,
  activeBackend: registration.descriptor,
  kind: "ready",
  reason: null,
  models,
})

/**
 * Always-ready Active Agent Backend for unit tests that do not exercise
 * readiness gates.
 */
export const stubActiveAgentBackendLayer = (
  overrides: Partial<{
    readonly registration: AgentBackendRegistration
    readonly getStatus: Effect.Effect<AgentBackendStatus>
    readonly requireAgentTurnsAllowed: Effect.Effect<
      void,
      AgentBackendBlockedError
    >
  }> = {},
): Layer.Layer<ActiveAgentBackend> => {
  const registration = overrides.registration ?? opencode
  return Layer.succeed(
    ActiveAgentBackend,
    ActiveAgentBackend.of({
      getStatus:
        overrides.getStatus ?? Effect.succeed(readyStatus(registration)),
      recheck: () => Effect.succeed(readyStatus(registration)),
      requireAgentTurnsAllowed:
        overrides.requireAgentTurnsAllowed ?? Effect.void,
      setSelectedBackend: () => Effect.succeed(readyStatus(registration)),
      getActiveRegistration: Effect.succeed(registration),
      getSessionTelemetry: (input) =>
        Effect.succeed(
          unsupportedSessionTelemetry(
            input.sessionId ?? "",
            registration.descriptor,
          ) satisfies SessionTelemetry,
        ),
    }),
  )
}

const grokRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.grok)
if (grokRegistration === undefined) {
  throw new Error("Grok Agent Backend registration is missing")
}

export const stubGrokActiveAgentBackendLayer: Layer.Layer<ActiveAgentBackend> =
  stubActiveAgentBackendLayer({ registration: grokRegistration })
