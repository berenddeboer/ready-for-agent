import { Context, Effect, Layer, Ref, Result, Schema, Semaphore } from "effect"
import type { AgentBackend } from "./agent-backend.js"
import { AgentBackend as AgentBackendService } from "./agent-backend.js"
import { AgentBackendConfigError } from "./errors.js"
import {
  type AgentBackendRegistration,
  capabilitySupported,
  defaultAgentBackendId,
  getBuiltInAgentBackend,
  isSelectableAgentBackendId,
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

export type AgentBackendStatusKind = "ready" | "unavailable"

export type AgentBackendStatus = {
  readonly selectedBackend: AgentBackendDescriptor
  readonly activeBackend: AgentBackendDescriptor
  readonly kind: AgentBackendStatusKind
  readonly reason: string | null
  readonly models: ReadonlyArray<AgentModel>
}

export type AgentBackendPreviewKind = "ready" | "unavailable"

export type AgentBackendPreview = {
  readonly backend: AgentBackendDescriptor
  readonly kind: AgentBackendPreviewKind
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

/** @deprecated Restart boundary removed; kept only for type narrowing during removal. */
export type AgentBackendBlockedError = AgentBackendUnavailableError

export type AgentBackendAdapter = {
  readonly inspect: AgentBackend["Service"]["inspect"]
  readonly startTurn: AgentBackend["Service"]["startTurn"]
  readonly continueTurn: AgentBackend["Service"]["continueTurn"]
}

export type AgentBackendTelemetry = {
  readonly getSession: (
    sessionId: string,
  ) => Effect.Effect<SessionTelemetry, never>
}

export type ResolvedAgentBackendRuntime = {
  readonly registration: AgentBackendRegistration
  readonly adapter: AgentBackendAdapter
  readonly telemetry: AgentBackendTelemetry
}

export type ResolveAgentBackendRuntime = (
  backendId: AgentBackendId,
) => Effect.Effect<ResolvedAgentBackendRuntime, unknown>

type ActiveState = {
  readonly registration: AgentBackendRegistration
  readonly adapter: AgentBackendAdapter
  readonly telemetry: AgentBackendTelemetry
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
  const activeBackend = state.registration.descriptor
  if (state.unavailableReason !== null) {
    return {
      selectedBackend: activeBackend,
      activeBackend,
      kind: "unavailable",
      reason: state.unavailableReason,
      models: [],
    }
  }
  return {
    selectedBackend: activeBackend,
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
    AgentBackendUnavailableError
  >
  /**
   * Hot-activate a backend: swap Active registration + adapter, then inspect.
   * Inspect failure leaves Active on the new backend in Unavailable.
   */
  readonly activate: (
    backendId: AgentBackendId,
    input: InspectInput,
  ) => Effect.Effect<AgentBackendStatus>
  /**
   * Settings-only inspect of a not-yet-saved backend. Does not change Active.
   */
  readonly preview: (
    backendId: AgentBackendId,
    input: InspectInput,
  ) => Effect.Effect<AgentBackendPreview>
  /**
   * Serialize Config backend commits + activate with Work Item creation so a
   * concurrent Implement Now cannot capture the pre-activate Active backend.
   */
  readonly withConfigCoordination: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
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
  readonly resolveRuntime: ResolveAgentBackendRuntime
}

/**
 * Active Agent Backend readiness, catalog, and hot-activation. Also provides
 * the process-wide AgentBackend + SessionTelemetryProvider proxies so turns
 * always use the currently Active adapter without a process restart.
 */
export const ActiveAgentBackendLive = (
  options: ActiveAgentBackendLiveOptions,
): Layer.Layer<
  ActiveAgentBackend | AgentBackendService | SessionTelemetryProvider
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const resolveOrUnavailable = (
        backendId: AgentBackendId,
      ): Effect.Effect<ResolvedAgentBackendRuntime> =>
        options.resolveRuntime(backendId).pipe(
          Effect.catch((error) => {
            const registration = resolveActiveRegistration(backendId)
            const reason = formatInspectFailure(error)
            const failConfig = () =>
              Effect.fail(new AgentBackendConfigError({ message: reason }))
            return Effect.succeed({
              registration,
              adapter: {
                inspect: failConfig,
                startTurn: failConfig,
                continueTurn: failConfig,
              },
              telemetry: {
                getSession: (sessionId: string) =>
                  Effect.succeed(
                    unsupportedSessionTelemetry(
                      sessionId,
                      registration.descriptor,
                    ),
                  ),
              },
            } satisfies ResolvedAgentBackendRuntime)
          }),
        )

      const initial = yield* resolveOrUnavailable(options.selectedBackendId)
      const stateRef = yield* Ref.make<ActiveState>({
        registration: initial.registration,
        adapter: initial.adapter,
        telemetry: initial.telemetry,
        models: [],
        unavailableReason: "Agent Backend has not been inspected yet",
      })
      const configCoordination = yield* Semaphore.make(1)
      const withConfigCoordination = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => configCoordination.withPermits(1)(effect)

      const getStatus = Ref.get(stateRef).pipe(Effect.map(toStatus))

      const recheck = Effect.fn("ActiveAgentBackend.recheck")(function* (
        input: InspectInput,
      ) {
        const current = yield* Ref.get(stateRef)
        const inspectedBackendId = current.registration.descriptor.id
        const inspected = yield* Effect.result(current.adapter.inspect(input))
        // Discard results if Active was swapped (activate) during inspect.
        const stillActive = (state: ActiveState): boolean =>
          state.registration.descriptor.id === inspectedBackendId
        if (Result.isFailure(inspected)) {
          const reason = formatInspectFailure(inspected.failure)
          yield* Ref.update(stateRef, (state) =>
            stillActive(state)
              ? {
                  ...state,
                  models: [],
                  unavailableReason: reason,
                }
              : state,
          )
          return yield* getStatus
        }
        yield* Ref.update(stateRef, (state) =>
          stillActive(state)
            ? {
                ...state,
                models: inspected.success.models,
                unavailableReason: null,
              }
            : state,
        )
        return yield* getStatus
      })

      const requireAgentTurnsAllowed = Effect.gen(function* () {
        const status = yield* getStatus
        if (status.kind === "unavailable") {
          return yield* new AgentBackendUnavailableError({
            message: status.reason ?? "Agent Backend is unavailable",
            reason: status.reason ?? "Agent Backend is unavailable",
          })
        }
      }).pipe(Effect.asVoid)

      const activate = Effect.fn("ActiveAgentBackend.activate")(function* (
        backendId: AgentBackendId,
        input: InspectInput,
      ) {
        const resolvedId = isSelectableAgentBackendId(backendId)
          ? backendId
          : defaultAgentBackendId
        const current = yield* Ref.get(stateRef)
        if (current.registration.descriptor.id !== resolvedId) {
          const runtime = yield* resolveOrUnavailable(resolvedId)
          yield* Ref.set(stateRef, {
            registration: runtime.registration,
            adapter: runtime.adapter,
            telemetry: runtime.telemetry,
            models: [],
            unavailableReason: "Agent Backend has not been inspected yet",
          })
        }
        return yield* recheck(input)
      })

      const preview = Effect.fn("ActiveAgentBackend.preview")(function* (
        backendId: AgentBackendId,
        input: InspectInput,
      ) {
        const resolvedId = isSelectableAgentBackendId(backendId)
          ? backendId
          : defaultAgentBackendId
        const backend = descriptorFor(resolvedId)
        const current = yield* Ref.get(stateRef)
        const adapter =
          current.registration.descriptor.id === resolvedId
            ? current.adapter
            : (yield* resolveOrUnavailable(resolvedId)).adapter
        const inspected = yield* Effect.result(adapter.inspect(input))
        if (Result.isFailure(inspected)) {
          return {
            backend,
            kind: "unavailable" as const,
            reason: formatInspectFailure(inspected.failure),
            models: [] as ReadonlyArray<AgentModel>,
          }
        }
        return {
          backend,
          kind: "ready" as const,
          reason: null,
          models: inspected.success.models,
        }
      })

      const getActiveRegistration = Ref.get(stateRef).pipe(
        Effect.map((state) => state.registration),
      )

      const getSessionTelemetry = Effect.fn(
        "ActiveAgentBackend.getSessionTelemetry",
      )(function* (input: {
        readonly backendId: string
        readonly sessionId: string | null
      }) {
        const registration =
          getBuiltInAgentBackend(input.backendId) ??
          (yield* Ref.get(stateRef)).registration
        const backend = registration.descriptor
        if (!capabilitySupported(registration, "SessionTelemetry")) {
          return unsupportedSessionTelemetry(input.sessionId ?? "", backend)
        }
        if (input.sessionId === null || input.sessionId.trim() === "") {
          return missingSessionTelemetry("", backend)
        }
        const state = yield* Ref.get(stateRef)
        if (state.registration.descriptor.id === registration.descriptor.id) {
          return yield* state.telemetry.getSession(input.sessionId)
        }
        // Historical provenance for a non-active backend: build telemetry once.
        const runtime = yield* resolveOrUnavailable(registration.descriptor.id)
        return yield* runtime.telemetry.getSession(input.sessionId)
      })

      const activeService = ActiveAgentBackend.of({
        getStatus,
        recheck,
        requireAgentTurnsAllowed,
        activate,
        preview,
        withConfigCoordination,
        getActiveRegistration,
        getSessionTelemetry,
      })

      const agentBackendService = AgentBackendService.of({
        inspect: (input) =>
          Ref.get(stateRef).pipe(
            Effect.flatMap((state) => state.adapter.inspect(input)),
          ),
        startTurn: (input) =>
          Ref.get(stateRef).pipe(
            Effect.flatMap((state) => state.adapter.startTurn(input)),
          ),
        continueTurn: (input) =>
          Ref.get(stateRef).pipe(
            Effect.flatMap((state) => state.adapter.continueTurn(input)),
          ),
      })

      const telemetryService = SessionTelemetryProvider.of({
        getSession: (sessionId) =>
          Ref.get(stateRef).pipe(
            Effect.flatMap((state) => state.telemetry.getSession(sessionId)),
          ),
      })

      return Layer.mergeAll(
        Layer.succeed(ActiveAgentBackend, activeService),
        Layer.succeed(AgentBackendService, agentBackendService),
        Layer.succeed(SessionTelemetryProvider, telemetryService),
      )
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
