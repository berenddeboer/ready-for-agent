import { Context, Effect, Layer, Ref, Result, Schema } from "effect"
import type { AgentBackend } from "./agent-backend.js"
import { AgentBackend as AgentBackendService } from "./agent-backend.js"
import {
  type AgentBackendRegistration,
  capabilitySupported,
  defaultAgentBackendId,
  getBuiltInAgentBackend,
} from "./registry.js"
import {
  type SessionTelemetry,
  SessionTelemetryProvider,
  missingSessionTelemetry,
  unsupportedSessionTelemetry,
} from "./session-telemetry.js"
import type {
  AgentBackendDescriptor,
  AgentBackendId,
  AgentModel,
  InspectInput,
} from "./types.js"

export type AgentBackendStatusKind =
  | "ready"
  | "unavailable"
  | "restart_required"

export type AgentBackendStatus = {
  readonly selectedBackend: AgentBackendDescriptor
  readonly activeBackend: AgentBackendDescriptor
  readonly kind: AgentBackendStatusKind
  readonly reason: string | null
  readonly models: ReadonlyArray<AgentModel>
}

export class AgentBackendUnavailableError extends Schema.TaggedErrorClass<AgentBackendUnavailableError>()(
  "AgentBackendUnavailableError",
  {
    message: Schema.String,
    reason: Schema.String,
  },
) {}

export class AgentBackendRestartRequiredError extends Schema.TaggedErrorClass<AgentBackendRestartRequiredError>()(
  "AgentBackendRestartRequiredError",
  {
    message: Schema.String,
    selectedBackendId: Schema.String,
    activeBackendId: Schema.String,
  },
) {}

export type AgentBackendBlockedError =
  | AgentBackendUnavailableError
  | AgentBackendRestartRequiredError

type ActiveState = {
  readonly selectedBackendId: AgentBackendId
  readonly activeRegistration: AgentBackendRegistration
  readonly models: ReadonlyArray<AgentModel>
  readonly unavailableReason: string | null
}

const descriptorFor = (id: AgentBackendId): AgentBackendDescriptor => {
  const registration = getBuiltInAgentBackend(id)
  if (registration !== undefined) {
    return registration.descriptor
  }
  return { id, label: id }
}

const toStatus = (state: ActiveState): AgentBackendStatus => {
  const activeBackend = state.activeRegistration.descriptor
  const selectedBackend = descriptorFor(state.selectedBackendId)
  if (state.selectedBackendId !== activeBackend.id) {
    return {
      selectedBackend,
      activeBackend,
      kind: "restart_required",
      reason: `Restart the Harness to activate ${selectedBackend.label}. ${activeBackend.label} remains active until restart.`,
      models: state.models,
    }
  }
  if (state.unavailableReason !== null) {
    return {
      selectedBackend,
      activeBackend,
      kind: "unavailable",
      reason: state.unavailableReason,
      models: [],
    }
  }
  return {
    selectedBackend,
    activeBackend,
    kind: "ready",
    reason: null,
    models: state.models,
  }
}

const formatInspectFailure = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    const message = (error as { message: string }).message.trim()
    if (message.length > 0) {
      return message
    }
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as { _tag: unknown })._tag === "string"
  ) {
    return `Agent Backend inspection failed (${(error as { _tag: string })._tag})`
  }
  return "Agent Backend inspection failed"
}

export type ActiveAgentBackendShape = {
  readonly getStatus: Effect.Effect<AgentBackendStatus>
  readonly recheck: (input: InspectInput) => Effect.Effect<AgentBackendStatus>
  readonly requireAgentTurnsAllowed: Effect.Effect<
    void,
    AgentBackendBlockedError
  >
  readonly setSelectedBackend: (
    selectedBackendId: AgentBackendId,
  ) => Effect.Effect<AgentBackendStatus>
  readonly getActiveRegistration: Effect.Effect<AgentBackendRegistration>
  readonly getSessionTelemetry: (input: {
    readonly backendId: string
    readonly sessionId: string | null
  }) => Effect.Effect<SessionTelemetry>
}

export class ActiveAgentBackend extends Context.Service<
  ActiveAgentBackend,
  ActiveAgentBackendShape
>()("@ready-for-agent/agent-backend/ActiveAgentBackend") {}

export type ActiveAgentBackendLiveOptions = {
  readonly selectedBackendId: AgentBackendId
  readonly activeRegistration: AgentBackendRegistration
}

/**
 * Active Agent Backend readiness and catalog. Construct after the adapter
 * AgentBackend layer. Startup/recheck inspect failures set Unavailable and
 * must not terminate the Harness process.
 */
export const ActiveAgentBackendLive = (
  options: ActiveAgentBackendLiveOptions,
): Layer.Layer<
  ActiveAgentBackend,
  never,
  AgentBackend | SessionTelemetryProvider
> =>
  Layer.effect(
    ActiveAgentBackend,
    Effect.gen(function* () {
      const agentBackend = yield* AgentBackendService
      const telemetry = yield* SessionTelemetryProvider
      const stateRef = yield* Ref.make<ActiveState>({
        selectedBackendId: options.selectedBackendId,
        activeRegistration: options.activeRegistration,
        models: [],
        unavailableReason: "Agent Backend has not been inspected yet",
      })

      const getStatus = Ref.get(stateRef).pipe(Effect.map(toStatus))

      const recheck = Effect.fn("ActiveAgentBackend.recheck")(function* (
        input: InspectInput,
      ) {
        const current = yield* Ref.get(stateRef)
        if (
          current.selectedBackendId !== current.activeRegistration.descriptor.id
        ) {
          return toStatus(current)
        }
        const inspected = yield* Effect.result(agentBackend.inspect(input))
        if (Result.isFailure(inspected)) {
          const reason = formatInspectFailure(inspected.failure)
          yield* Ref.update(stateRef, (state) => ({
            ...state,
            models: [],
            unavailableReason: reason,
          }))
          return yield* getStatus
        }
        yield* Ref.update(stateRef, (state) => ({
          ...state,
          models: inspected.success.models,
          unavailableReason: null,
        }))
        return yield* getStatus
      })

      const requireAgentTurnsAllowed = Effect.gen(function* () {
        const status = yield* getStatus
        if (status.kind === "restart_required") {
          return yield* new AgentBackendRestartRequiredError({
            message:
              status.reason ??
              "Restart the Harness to activate the selected Agent Backend",
            selectedBackendId: status.selectedBackend.id,
            activeBackendId: status.activeBackend.id,
          })
        }
        if (status.kind === "unavailable") {
          return yield* new AgentBackendUnavailableError({
            message: status.reason ?? "Agent Backend is unavailable",
            reason: status.reason ?? "Agent Backend is unavailable",
          })
        }
      }).pipe(Effect.asVoid)

      const setSelectedBackend = Effect.fn(
        "ActiveAgentBackend.setSelectedBackend",
      )(function* (selectedBackendId: AgentBackendId) {
        yield* Ref.update(stateRef, (state) => ({
          ...state,
          selectedBackendId,
        }))
        return yield* getStatus
      })

      const getActiveRegistration = Ref.get(stateRef).pipe(
        Effect.map((state) => state.activeRegistration),
      )

      const getSessionTelemetry = Effect.fn(
        "ActiveAgentBackend.getSessionTelemetry",
      )(function* (input: {
        readonly backendId: string
        readonly sessionId: string | null
      }) {
        const registration =
          getBuiltInAgentBackend(input.backendId) ??
          (yield* Ref.get(stateRef)).activeRegistration
        const backend = registration.descriptor
        if (!capabilitySupported(registration, "SessionTelemetry")) {
          return unsupportedSessionTelemetry(input.sessionId ?? "", backend)
        }
        if (input.sessionId === null || input.sessionId.trim() === "") {
          return missingSessionTelemetry("", backend)
        }
        return yield* telemetry.getSession(input.sessionId)
      })

      return ActiveAgentBackend.of({
        getStatus,
        recheck,
        requireAgentTurnsAllowed,
        setSelectedBackend,
        getActiveRegistration,
        getSessionTelemetry,
      })
    }),
  )

export const resolveActiveRegistration = (
  selectedBackendId: string,
): AgentBackendRegistration => {
  const selected = getBuiltInAgentBackend(selectedBackendId)
  if (selected !== undefined) {
    return selected
  }
  const fallback = getBuiltInAgentBackend(defaultAgentBackendId)
  if (fallback === undefined) {
    throw new Error("Built-in OpenCode Agent Backend registration is missing")
  }
  return fallback
}
