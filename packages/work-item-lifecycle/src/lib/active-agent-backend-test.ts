import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  type AgentBackendBlockedError,
  type AgentBackendId,
  type AgentBackendRegistration,
  type AgentBackendRuntimeStatus,
  type AgentBackendStatus,
  type AgentTurnResult,
  type ContinueTurnInput,
  type SessionTelemetry,
  type StartTurnInput,
  getBuiltInAgentBackend,
  isSelectableAgentBackendId,
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
  provider: null,
  warnings: [],
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
    /** Additional Active registrations (for multi-backend routing tests). */
    readonly registrations: ReadonlyArray<AgentBackendRegistration>
    /**
     * Ready catalog reported for every Active backend. Defaults to empty,
     * which carries no membership information and therefore does not gate
     * Agent Model admission (issue #838).
     */
    readonly models: AgentBackendRuntimeStatus["models"]
    /**
     * Status applied to backends that become Active only through
     * activate / setSelectedOrInUse (not in the initial registrations).
     */
    readonly newlyActivatedKind?: AgentBackendRuntimeStatus["kind"]
    readonly newlyActivatedReason?: string
    readonly getStatus: Effect.Effect<AgentBackendStatus>
    readonly requireAgentTurnsAllowed: Effect.Effect<
      void,
      AgentBackendBlockedError
    >
    /**
     * Per-backend require override. When set, consulted before the singular
     * {@link requireAgentTurnsAllowed} Effect.
     */
    readonly requireAgentTurnsAllowedFor: (
      backendId: AgentBackendId,
    ) => Effect.Effect<void, AgentBackendBlockedError>
    readonly startTurn: (
      backendId: AgentBackendId,
      input: StartTurnInput,
    ) => Effect.Effect<AgentTurnResult, never>
    readonly continueTurn: (
      backendId: AgentBackendId,
      input: ContinueTurnInput,
    ) => Effect.Effect<AgentTurnResult, never>
  }> = {},
): Layer.Layer<ActiveAgentBackend> => {
  const registration = overrides.registration ?? opencode
  const allRegistrations = [
    registration,
    ...(overrides.registrations ?? []).filter(
      (entry) => entry.descriptor.id !== registration.descriptor.id,
    ),
  ]
  const byId = new Map<AgentBackendId, AgentBackendRegistration>(
    allRegistrations.map((entry) => [entry.descriptor.id, entry] as const),
  )
  const readyFor = (entry: AgentBackendRegistration) =>
    runtimeStatus(entry, overrides.models ?? [])
  const allReady = allRegistrations.map(readyFor)
  const activeIds = new Set<AgentBackendId>(byId.keys())
  const legacyStatus =
    overrides.getStatus ?? Effect.succeed(readyStatus(registration))
  const requireAllowed = overrides.requireAgentTurnsAllowed ?? Effect.void
  const requireFor =
    overrides.requireAgentTurnsAllowedFor ??
    ((_backendId: AgentBackendId) => requireAllowed)
  const registrationFor = (backendId: string): AgentBackendRegistration => {
    const entry = byId.get(backendId as AgentBackendId)
    if (entry !== undefined) {
      return entry
    }
    // Prefer real built-ins over silently returning the primary registration,
    // so multi-backend tests cannot green-pass with the wrong descriptor.
    if (isSelectableAgentBackendId(backendId)) {
      const builtIn = getBuiltInAgentBackend(backendId)
      if (builtIn !== undefined) {
        return builtIn
      }
    }
    throw new Error(
      `stub ActiveAgentBackend: unknown Agent Backend id: ${backendId}`,
    )
  }

  return Layer.succeed(
    ActiveAgentBackend,
    ActiveAgentBackend.of({
      listStatuses: Effect.succeed(allReady),
      getBackendStatus: (backendId: AgentBackendId) => {
        if (!activeIds.has(backendId)) {
          return Effect.succeed(null)
        }
        if (
          !byId.has(backendId) &&
          overrides.newlyActivatedKind === "unavailable"
        ) {
          return Effect.succeed(
            runtimeStatus(
              registrationFor(backendId),
              [],
              "unavailable",
              overrides.newlyActivatedReason ?? "inspect failed",
            ),
          )
        }
        return Effect.succeed(readyFor(registrationFor(backendId)))
      },
      getStatus: legacyStatus,
      setSelectedOrInUse: (backendIds) =>
        Effect.sync(() => {
          activeIds.clear()
          for (const backendId of backendIds) {
            activeIds.add(backendId)
          }
          return [...activeIds].map((backendId) =>
            readyFor(registrationFor(backendId)),
          )
        }),
      activate: (backendId) =>
        Effect.sync(() => {
          activeIds.add(backendId)
          return readyFor(registrationFor(backendId))
        }),
      drop: (backendId) =>
        Effect.sync(() => {
          activeIds.delete(backendId)
        }),
      recheck: (backendId) =>
        Effect.succeed(readyFor(registrationFor(backendId))),
      requireAgentTurnsAllowed: (backendId) => requireFor(backendId),
      preview: (backendId) =>
        Effect.succeed({
          backend: registrationFor(backendId).descriptor,
          kind: "ready" as const,
          reason: null,
          models: overrides.models ?? [],
          provider: null,
          warnings: [],
        }),
      withConfigCoordination: (effect) => effect,
      getRegistration: (backendId) =>
        Effect.succeed(registrationFor(backendId)),
      getActiveRegistration: Effect.succeed(registration),
      startTurn: (backendId, input) =>
        overrides.startTurn !== undefined
          ? overrides.startTurn(backendId, input)
          : Effect.die("stub ActiveAgentBackend.startTurn unused"),
      continueTurn: (backendId, input) =>
        overrides.continueTurn !== undefined
          ? overrides.continueTurn(backendId, input)
          : Effect.die("stub ActiveAgentBackend.continueTurn unused"),
      inspectBackend: () =>
        Effect.die("stub ActiveAgentBackend.inspectBackend unused"),
      getSessionTelemetry: (input) =>
        Effect.succeed(
          unsupportedSessionTelemetry(
            input.sessionId ?? "",
            registrationFor(input.backendId).descriptor,
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
