import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  type AgentBackendBlockedError,
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
  models: AgentBackendStatus["models"] = [],
): AgentBackendStatus => ({
  selectedBackend: opencode.descriptor,
  activeBackend: opencode.descriptor,
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
    readonly getStatus: Effect.Effect<AgentBackendStatus>
    readonly requireAgentTurnsAllowed: Effect.Effect<
      void,
      AgentBackendBlockedError
    >
  }> = {},
): Layer.Layer<ActiveAgentBackend> =>
  Layer.succeed(
    ActiveAgentBackend,
    ActiveAgentBackend.of({
      getStatus: overrides.getStatus ?? Effect.succeed(readyStatus()),
      recheck: () => Effect.succeed(readyStatus()),
      requireAgentTurnsAllowed:
        overrides.requireAgentTurnsAllowed ?? Effect.void,
      setSelectedBackend: () => Effect.succeed(readyStatus()),
      getActiveRegistration: Effect.succeed(opencode),
      getSessionTelemetry: (input) =>
        Effect.succeed(
          unsupportedSessionTelemetry(
            input.sessionId ?? "",
            opencode.descriptor,
          ) satisfies SessionTelemetry,
        ),
    }),
  )
