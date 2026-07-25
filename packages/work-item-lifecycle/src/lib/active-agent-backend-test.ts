import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  type AgentBackendBlockedError,
  type AgentBackendId,
  type AgentBackendRegistration,
  type AgentBackendRuntimeStatus,
  type AgentBackendStatus,
  type SessionTelemetry,
  getBuiltInAgentBackend,
  toAgentBackendStatus,
  unsupportedSessionTelemetry,
} from "@ready-for-agent/agent-backend"

const opencodeRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.opencode)
if (opencodeRegistration === undefined) {
  throw new Error("OpenCode Agent Backend registration is missing")
}
const opencode = opencodeRegistration

const runtimeStatus = (
  registration: AgentBackendRegistration,
  models: AgentBackendRuntimeStatus["models"] = [],
  kind: AgentBackendRuntimeStatus["kind"] = "ready",
  reason: string | null = null,
): AgentBackendRuntimeStatus => ({
  backend: registration.descriptor,
  kind,
  reason: kind === "unavailable" ? (reason ?? "unavailable") : null,
  models: kind === "unavailable" ? [] : models,
})

const readyStatus = (
  registration: AgentBackendRegistration,
  models: AgentBackendStatus["models"] = [],
): AgentBackendStatus =>
  toAgentBackendStatus(runtimeStatus(registration, models))

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
  const ready = runtimeStatus(registration)
  const legacyStatus =
    overrides.getStatus ?? Effect.succeed(readyStatus(registration))
  const requireAllowed = overrides.requireAgentTurnsAllowed ?? Effect.void

  return Layer.succeed(
    ActiveAgentBackend,
    ActiveAgentBackend.of({
      listStatuses: Effect.succeed([ready]),
      getBackendStatus: (backendId: AgentBackendId) =>
        Effect.succeed(backendId === registration.descriptor.id ? ready : null),
      getStatus: legacyStatus,
      setSelectedOrInUse: () => Effect.succeed([ready]),
      activate: () => Effect.succeed(ready),
      drop: () => Effect.void,
      recheck: () => Effect.succeed(ready),
      requireAgentTurnsAllowed: (_backendId) => requireAllowed,
      preview: () =>
        Effect.succeed({
          backend: registration.descriptor,
          kind: "ready" as const,
          reason: null,
          models: [],
        }),
      withConfigCoordination: (effect) => effect,
      getRegistration: () => Effect.succeed(registration),
      getActiveRegistration: Effect.succeed(registration),
      startTurn: () => Effect.die("stub ActiveAgentBackend.startTurn unused"),
      continueTurn: () =>
        Effect.die("stub ActiveAgentBackend.continueTurn unused"),
      inspectBackend: () =>
        Effect.die("stub ActiveAgentBackend.inspectBackend unused"),
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
