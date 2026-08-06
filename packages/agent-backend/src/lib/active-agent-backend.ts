import { Context, Effect, Layer, Ref, Result, Schema, Semaphore } from "effect"
import type { AgentBackend, AgentBackendError } from "./agent-backend.js"
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
  AgentBackendProvider,
  AgentModel,
  AgentTurnResult,
  ContinueTurnInput,
  InspectInput,
  InspectResult,
  StartTurnInput,
} from "./types.js"

export type AgentBackendStatusKind = "ready" | "unavailable"

/**
 * Per-backend readiness for one Active Agent Backend: Ready or Unavailable
 * with reason and model catalog.
 */
export type AgentBackendRuntimeStatus = {
  readonly backend: AgentBackendDescriptor
  readonly kind: AgentBackendStatusKind
  readonly reason: string | null
  readonly models: ReadonlyArray<AgentModel>
  /**
   * Last known hosting provider from inspect: a successful Ready result, or an
   * unauth ConfigError that carried identity (e.g. Claude Code Amazon Bedrock).
   */
  readonly provider: AgentBackendProvider | null
  /**
   * Non-fatal inspect warnings cached with Ready status (e.g. Bedrock catalog
   * discovery). Empty when Unavailable or when inspect reported none.
   */
  readonly warnings: ReadonlyArray<string>
}

/**
 * Singular Selected/Active status view used by GraphQL until multi-status
 * lands (#467). `selectedBackend` and `activeBackend` are the same descriptor
 * for a registry entry (no Selected≠Active limbo).
 */
export type AgentBackendStatus = {
  readonly selectedBackend: AgentBackendDescriptor
  readonly activeBackend: AgentBackendDescriptor
  readonly kind: AgentBackendStatusKind
  readonly reason: string | null
  readonly models: ReadonlyArray<AgentModel>
  readonly provider: AgentBackendProvider | null
  readonly warnings: ReadonlyArray<string>
}

export type AgentBackendPreviewKind = "ready" | "unavailable"

export type AgentBackendPreview = {
  readonly backend: AgentBackendDescriptor
  readonly kind: AgentBackendPreviewKind
  readonly reason: string | null
  readonly models: ReadonlyArray<AgentModel>
  readonly provider: AgentBackendProvider | null
  readonly warnings: ReadonlyArray<string>
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

type ActiveEntry = {
  readonly registration: AgentBackendRegistration
  readonly adapter: AgentBackendAdapter
  readonly telemetry: AgentBackendTelemetry
  readonly models: ReadonlyArray<AgentModel>
  readonly unavailableReason: string | null
  /**
   * Last known inspect provider (Ready success or unauth ConfigError identity),
   * or null when unknown / not reported.
   */
  readonly provider: AgentBackendProvider | null
  /** Non-fatal Ready warnings from the last successful inspect. */
  readonly warnings: ReadonlyArray<string>
}

const normalizeInspectProvider = (
  provider: InspectResult["provider"],
): AgentBackendProvider | null => provider ?? null

const normalizeInspectWarnings = (
  warnings: InspectResult["warnings"],
): ReadonlyArray<string> => {
  if (warnings === undefined) {
    return []
  }
  return warnings
    .map((warning) => warning.trim())
    .filter((warning) => warning.length > 0)
}

type RegistryState = {
  /** Active backends keyed by backend id. */
  readonly entries: ReadonlyMap<string, ActiveEntry>
  /**
   * Backend id used by the process-wide AgentBackend / SessionTelemetryProvider
   * proxies until lifecycle routes by captured Work Item backend (#466).
   */
  readonly proxyBackendId: AgentBackendId
}

const descriptorFor = (id: AgentBackendId): AgentBackendDescriptor => {
  const registration = getBuiltInAgentBackend(id)
  if (registration !== undefined) {
    return registration.descriptor
  }
  return { id, label: id }
}

const normalizeBackendId = (backendId: string): AgentBackendId =>
  isSelectableAgentBackendId(backendId) ? backendId : defaultAgentBackendId

const toRuntimeStatus = (entry: ActiveEntry): AgentBackendRuntimeStatus => {
  const backend = entry.registration.descriptor
  if (entry.unavailableReason !== null) {
    return {
      backend,
      kind: "unavailable",
      reason: entry.unavailableReason,
      models: [],
      // Keep last-known provider on Unavailable so Settings can still show
      // which hosting path failed when inspect previously reported one.
      provider: entry.provider,
      // Warnings are Ready-only catalog signals; clear them when Unavailable.
      warnings: [],
    }
  }
  return {
    backend,
    kind: "ready",
    reason: null,
    models: entry.models,
    provider: entry.provider,
    warnings: entry.warnings,
  }
}

/** Map a runtime status to the singular GraphQL-facing shape. */
export const toAgentBackendStatus = (
  status: AgentBackendRuntimeStatus,
): AgentBackendStatus => ({
  selectedBackend: status.backend,
  activeBackend: status.backend,
  kind: status.kind,
  reason: status.reason,
  models: status.models,
  provider: status.provider,
  warnings: status.warnings,
})

const notActiveStatus = (
  backendId: AgentBackendId,
): AgentBackendRuntimeStatus => ({
  backend: descriptorFor(backendId),
  kind: "unavailable",
  reason: "Agent Backend is not Active",
  models: [],
  provider: null,
  warnings: [],
})

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

/**
 * Provider identity attached to an inspect ConfigError (e.g. Claude unauth
 * with known apiProvider). Null when the failure does not carry one.
 */
const providerFromInspectFailure = (
  error: unknown,
): AgentBackendProvider | null => {
  if (
    error instanceof AgentBackendConfigError &&
    error.provider !== undefined
  ) {
    const id = error.provider.id.trim()
    const label = error.provider.label.trim()
    if (id.length > 0 && label.length > 0) {
      return { id, label }
    }
  }
  return null
}

const emptyEntry = (
  runtime: ResolvedAgentBackendRuntime,
  unavailableReason: string | null,
): ActiveEntry => ({
  registration: runtime.registration,
  adapter: runtime.adapter,
  telemetry: runtime.telemetry,
  models: [],
  unavailableReason,
  provider: null,
  warnings: [],
})

export type ActiveAgentBackendShape = {
  /** Status for every Active backend (order not significant). */
  readonly listStatuses: Effect.Effect<ReadonlyArray<AgentBackendRuntimeStatus>>
  /**
   * Status for one backend if it is Active; `null` when the id is not in the
   * Active set.
   */
  readonly getBackendStatus: (
    backendId: AgentBackendId,
  ) => Effect.Effect<AgentBackendRuntimeStatus | null>
  /**
   * Singular status of the process-wide proxy backend (legacy GraphQL/lifecycle
   * surface until multi-status #467 and lifecycle routing #466).
   */
  readonly getStatus: Effect.Effect<AgentBackendStatus>
  /**
   * Make `backendIds` the exact selected-or-in-use Active set: activate and
   * inspect missing ids, drop the rest. Same-backend members that are already
   * Active are left as-is (no re-inspect; Recheck stays explicit).
   */
  readonly setSelectedOrInUse: (
    backendIds: ReadonlyArray<AgentBackendId>,
    input: InspectInput,
  ) => Effect.Effect<ReadonlyArray<AgentBackendRuntimeStatus>>
  /**
   * Hot-activate one backend on demand. Inspect failure leaves that backend
   * Active and Unavailable. When already Active, returns current status without
   * re-inspect (same-backend re-Save skips full re-inspect). Also moves the
   * process-wide proxy to this backend until lifecycle routes by captured id.
   */
  readonly activate: (
    backendId: AgentBackendId,
    input: InspectInput,
  ) => Effect.Effect<AgentBackendRuntimeStatus>
  /** Drop a backend from the Active set when it leaves selected-or-in-use. */
  readonly drop: (backendId: AgentBackendId) => Effect.Effect<void>
  /**
   * Recheck (inspect) one backend that is already Active. Does not add missing
   * ids to the Active set — use `activate` or `setSelectedOrInUse` for that.
   */
  readonly recheck: (
    backendId: AgentBackendId,
    input: InspectInput,
  ) => Effect.Effect<AgentBackendRuntimeStatus>
  readonly requireAgentTurnsAllowed: (
    backendId: AgentBackendId,
  ) => Effect.Effect<void, AgentBackendUnavailableError>
  /**
   * Settings-only inspect of a not-yet-saved backend. Does not change the
   * Active set.
   */
  readonly preview: (
    backendId: AgentBackendId,
    input: InspectInput,
  ) => Effect.Effect<AgentBackendPreview>
  /**
   * Serialize Config/Repository backend commits + activate with Work Item
   * creation so a concurrent Implement Now cannot capture a pre-activate
   * backend.
   */
  readonly withConfigCoordination: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly getRegistration: (
    backendId: AgentBackendId,
  ) => Effect.Effect<AgentBackendRegistration>
  /**
   * Registration for the process-wide proxy backend (legacy until #466 routes
   * by captured Work Item backend).
   */
  readonly getActiveRegistration: Effect.Effect<AgentBackendRegistration>
  /** Dispatch startTurn to the Active adapter for `backendId`. */
  readonly startTurn: (
    backendId: AgentBackendId,
    input: StartTurnInput,
  ) => Effect.Effect<AgentTurnResult, AgentBackendError>
  /** Dispatch continueTurn to the Active adapter for `backendId`. */
  readonly continueTurn: (
    backendId: AgentBackendId,
    input: ContinueTurnInput,
  ) => Effect.Effect<AgentTurnResult, AgentBackendError>
  /** Dispatch inspect to the Active adapter for `backendId`. */
  readonly inspectBackend: (
    backendId: AgentBackendId,
    input: InspectInput,
  ) => Effect.Effect<InspectResult, AgentBackendError>
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
  /**
   * Initial selected-or-in-use backend ids. When empty or omitted, falls back
   * to `selectedBackendId` or the built-in default.
   */
  readonly initialBackendIds?: ReadonlyArray<AgentBackendId>
  /**
   * Single initial backend (and process-wide proxy default). Prefer
   * `initialBackendIds` when multiple backends should be Active at startup.
   */
  readonly selectedBackendId?: AgentBackendId
  readonly resolveRuntime: ResolveAgentBackendRuntime
}

/**
 * Multi-backend Active Agent Backend registry: readiness, catalog, activate,
 * recheck, and turn/telemetry dispatch by backend id. Also provides process-wide
 * AgentBackend + SessionTelemetryProvider proxies that route to the proxy
 * default backend until lifecycle routes by captured Work Item id.
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

      const seedIds = (() => {
        const fromList = options.initialBackendIds ?? []
        if (fromList.length > 0) {
          const ids = [...new Set(fromList.map(normalizeBackendId))]
          // Ensure Config's selected backend is in the Active set even if the
          // selected-or-in-use list was incomplete, so proxy can target it.
          if (options.selectedBackendId !== undefined) {
            const preferred = normalizeBackendId(options.selectedBackendId)
            if (!ids.includes(preferred)) {
              ids.unshift(preferred)
            }
          }
          return ids
        }
        const single = options.selectedBackendId ?? defaultAgentBackendId
        return [normalizeBackendId(single)]
      })()
      // Prefer Config's selected backend as the process-wide proxy when it is
      // Active; do not use list order alone (product-default-first lists would
      // otherwise steal the proxy from a non-default harness selection).
      const preferredProxy =
        options.selectedBackendId !== undefined
          ? normalizeBackendId(options.selectedBackendId)
          : undefined
      const proxyBackendId =
        preferredProxy !== undefined && seedIds.includes(preferredProxy)
          ? preferredProxy
          : (seedIds[0] ?? defaultAgentBackendId)

      const initialEntries = new Map<string, ActiveEntry>()
      for (const id of seedIds) {
        const runtime = yield* resolveOrUnavailable(id)
        initialEntries.set(
          id,
          emptyEntry(runtime, "Agent Backend has not been inspected yet"),
        )
      }

      const stateRef = yield* Ref.make<RegistryState>({
        entries: initialEntries,
        proxyBackendId,
      })
      const configCoordination = yield* Semaphore.make(1)
      const withConfigCoordination = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> => configCoordination.withPermits(1)(effect)

      const listStatuses = Ref.get(stateRef).pipe(
        Effect.map((state) =>
          [...state.entries.values()].map((entry) => toRuntimeStatus(entry)),
        ),
      )

      const getBackendStatus = (backendId: AgentBackendId) =>
        Ref.get(stateRef).pipe(
          Effect.map((state) => {
            const entry = state.entries.get(normalizeBackendId(backendId))
            return entry === undefined ? null : toRuntimeStatus(entry)
          }),
        )

      const getStatus = Ref.get(stateRef).pipe(
        Effect.map((state) => {
          const entry = state.entries.get(state.proxyBackendId)
          if (entry === undefined) {
            return toAgentBackendStatus(notActiveStatus(state.proxyBackendId))
          }
          return toAgentBackendStatus(toRuntimeStatus(entry))
        }),
      )

      type EnsureOutcome = {
        readonly resolvedId: AgentBackendId
        readonly entry: ActiveEntry
        readonly created: boolean
      }

      /**
       * Install a registry entry if missing. Resolve outside the ref, then
       * install only when still absent so concurrent first-activates cannot
       * clobber a finished inspect with a fresh empty entry.
       */
      const ensureEntry = Effect.fn("ActiveAgentBackend.ensureEntry")(
        function* (backendId: AgentBackendId) {
          const resolvedId = normalizeBackendId(backendId)
          const current = yield* Ref.get(stateRef)
          const existing = current.entries.get(resolvedId)
          if (existing !== undefined) {
            return {
              resolvedId,
              entry: existing,
              created: false,
            } satisfies EnsureOutcome
          }
          const runtime = yield* resolveOrUnavailable(resolvedId)
          const candidate = emptyEntry(
            runtime,
            "Agent Backend has not been inspected yet",
          )
          return yield* Ref.modify(
            stateRef,
            (state): [EnsureOutcome, RegistryState] => {
              const present = state.entries.get(resolvedId)
              if (present !== undefined) {
                return [
                  {
                    resolvedId,
                    entry: present,
                    created: false,
                  },
                  state,
                ]
              }
              const entries = new Map(state.entries)
              entries.set(resolvedId, candidate)
              return [
                {
                  resolvedId,
                  entry: candidate,
                  created: true,
                },
                { ...state, entries },
              ]
            },
          )
        },
      )

      const inspectActiveEntry = (
        inspectedBackendId: AgentBackendId,
        entryAtStart: ActiveEntry,
        input: InspectInput,
      ): Effect.Effect<AgentBackendRuntimeStatus> =>
        Effect.gen(function* () {
          const inspected = yield* Effect.result(
            entryAtStart.adapter.inspect(input),
          )
          // Discard results if this backend was dropped or replaced mid-inspect.
          const stillSameEntry = (state: RegistryState): boolean => {
            const previous = state.entries.get(inspectedBackendId)
            return (
              previous !== undefined &&
              previous.adapter === entryAtStart.adapter
            )
          }
          if (Result.isFailure(inspected)) {
            const reason = formatInspectFailure(inspected.failure)
            // Prefer provider reported with this failure (first Unavailable);
            // otherwise keep last known identity across recheck failures.
            const failureProvider = providerFromInspectFailure(
              inspected.failure,
            )
            yield* Ref.update(stateRef, (state) => {
              if (!stillSameEntry(state)) {
                return state
              }
              const previous = state.entries.get(inspectedBackendId)
              if (previous === undefined) {
                return state
              }
              const entries = new Map(state.entries)
              entries.set(inspectedBackendId, {
                ...previous,
                models: [],
                unavailableReason: reason,
                provider: failureProvider ?? previous.provider,
                warnings: [],
              })
              return { ...state, entries }
            })
            const status = yield* getBackendStatus(inspectedBackendId)
            return status ?? notActiveStatus(inspectedBackendId)
          }
          yield* Ref.update(stateRef, (state) => {
            if (!stillSameEntry(state)) {
              return state
            }
            const previous = state.entries.get(inspectedBackendId)
            if (previous === undefined) {
              return state
            }
            const entries = new Map(state.entries)
            // Atomic Ready refresh: models, provider, and warnings together.
            entries.set(inspectedBackendId, {
              ...previous,
              models: inspected.success.models,
              unavailableReason: null,
              provider: normalizeInspectProvider(inspected.success.provider),
              warnings: normalizeInspectWarnings(inspected.success.warnings),
            })
            return { ...state, entries }
          })
          const status = yield* getBackendStatus(inspectedBackendId)
          return status ?? notActiveStatus(inspectedBackendId)
        })

      const recheck = Effect.fn("ActiveAgentBackend.recheck")(function* (
        backendId: AgentBackendId,
        input: InspectInput,
      ) {
        const resolvedId = normalizeBackendId(backendId)
        const current = yield* Ref.get(stateRef)
        const entry = current.entries.get(resolvedId)
        if (entry === undefined) {
          // Recheck does not expand the Active set.
          return notActiveStatus(resolvedId)
        }
        return yield* inspectActiveEntry(resolvedId, entry, input)
      })

      const activate = Effect.fn("ActiveAgentBackend.activate")(function* (
        backendId: AgentBackendId,
        input: InspectInput,
      ) {
        const resolvedId = normalizeBackendId(backendId)
        const current = yield* Ref.get(stateRef)
        if (current.entries.has(resolvedId)) {
          // Already Active: move proxy, skip full re-inspect (Recheck explicit).
          yield* Ref.update(stateRef, (state) => ({
            ...state,
            proxyBackendId: resolvedId,
          }))
          const entry = current.entries.get(resolvedId)
          if (entry !== undefined) {
            return toRuntimeStatus(entry)
          }
        }
        // Ensure the registry row exists before retargeting the process-wide
        // proxy so concurrent AgentBackend calls never see a missing entry.
        const ensured = yield* ensureEntry(resolvedId)
        yield* Ref.update(stateRef, (state) => ({
          ...state,
          proxyBackendId: resolvedId,
        }))
        return yield* inspectActiveEntry(
          ensured.resolvedId,
          ensured.entry,
          input,
        )
      })

      const drop = Effect.fn("ActiveAgentBackend.drop")(function* (
        backendId: AgentBackendId,
      ) {
        const resolvedId = normalizeBackendId(backendId)
        yield* Ref.update(stateRef, (state) => {
          if (!state.entries.has(resolvedId)) {
            return state
          }
          const entries = new Map(state.entries)
          entries.delete(resolvedId)
          let nextProxy = state.proxyBackendId
          if (nextProxy === resolvedId) {
            const remaining = entries.keys().next()
            // Prefer another Active backend; otherwise fall back to built-in
            // default rather than leaving proxy on a deleted id.
            nextProxy =
              remaining.done === true
                ? defaultAgentBackendId
                : (remaining.value as AgentBackendId)
          }
          return { entries, proxyBackendId: nextProxy }
        })
      })

      const setSelectedOrInUse = Effect.fn(
        "ActiveAgentBackend.setSelectedOrInUse",
      )(function* (
        backendIds: ReadonlyArray<AgentBackendId>,
        input: InspectInput,
      ) {
        const desired = [
          ...new Set(
            (backendIds.length > 0 ? backendIds : [defaultAgentBackendId]).map(
              normalizeBackendId,
            ),
          ),
        ]
        const current = yield* Ref.get(stateRef)
        for (const id of current.entries.keys()) {
          if (!desired.includes(id as AgentBackendId)) {
            yield* drop(id as AgentBackendId)
          }
        }
        for (const id of desired) {
          const status = yield* getBackendStatus(id)
          if (status === null) {
            // Activate (ensure + inspect) rather than recheck: recheck does
            // not expand the Active set.
            yield* ensureEntry(id).pipe(
              Effect.flatMap((ensured) =>
                inspectActiveEntry(ensured.resolvedId, ensured.entry, input),
              ),
            )
          }
        }
        // Prefer keeping the previous proxy when it remains selected-or-in-use.
        yield* Ref.update(stateRef, (state) => {
          if (desired.includes(state.proxyBackendId)) {
            return state
          }
          return {
            ...state,
            proxyBackendId: desired[0] ?? defaultAgentBackendId,
          }
        })
        return yield* listStatuses
      })

      const requireAgentTurnsAllowed = (backendId: AgentBackendId) =>
        Effect.gen(function* () {
          const resolvedId = normalizeBackendId(backendId)
          const status = yield* getBackendStatus(resolvedId)
          if (status === null) {
            return yield* new AgentBackendUnavailableError({
              message: "Agent Backend is not Active",
              reason: "Agent Backend is not Active",
            })
          }
          if (status.kind === "unavailable") {
            return yield* new AgentBackendUnavailableError({
              message: status.reason ?? "Agent Backend is unavailable",
              reason: status.reason ?? "Agent Backend is unavailable",
            })
          }
        }).pipe(Effect.asVoid)

      const preview = Effect.fn("ActiveAgentBackend.preview")(function* (
        backendId: AgentBackendId,
        input: InspectInput,
      ) {
        const resolvedId = normalizeBackendId(backendId)
        const backend = descriptorFor(resolvedId)
        const current = yield* Ref.get(stateRef)
        const existing = current.entries.get(resolvedId)
        const adapter =
          existing !== undefined
            ? existing.adapter
            : (yield* resolveOrUnavailable(resolvedId)).adapter
        const inspected = yield* Effect.result(adapter.inspect(input))
        if (Result.isFailure(inspected)) {
          return {
            backend,
            kind: "unavailable" as const,
            reason: formatInspectFailure(inspected.failure),
            models: [] as ReadonlyArray<AgentModel>,
            provider: providerFromInspectFailure(inspected.failure),
            warnings: [] as ReadonlyArray<string>,
          }
        }
        // Preview must not mutate the Active set.
        return {
          backend,
          kind: "ready" as const,
          reason: null,
          models: inspected.success.models,
          provider: normalizeInspectProvider(inspected.success.provider),
          warnings: normalizeInspectWarnings(inspected.success.warnings),
        }
      })

      const getRegistration = (backendId: AgentBackendId) =>
        Ref.get(stateRef).pipe(
          Effect.map((state) => {
            const resolvedId = normalizeBackendId(backendId)
            const entry = state.entries.get(resolvedId)
            if (entry !== undefined) {
              return entry.registration
            }
            return resolveActiveRegistration(resolvedId)
          }),
        )

      const getActiveRegistration = Ref.get(stateRef).pipe(
        Effect.map((state) => {
          const entry = state.entries.get(state.proxyBackendId)
          if (entry !== undefined) {
            return entry.registration
          }
          return resolveActiveRegistration(state.proxyBackendId)
        }),
      )

      const requireActiveEntry = (
        backendId: AgentBackendId,
      ): Effect.Effect<ActiveEntry, AgentBackendError> =>
        Ref.get(stateRef).pipe(
          Effect.flatMap((state) => {
            const resolvedId = normalizeBackendId(backendId)
            const entry = state.entries.get(resolvedId)
            if (entry === undefined) {
              return Effect.fail(
                new AgentBackendConfigError({
                  message: `Agent Backend is not Active: ${resolvedId}`,
                }),
              )
            }
            return Effect.succeed(entry)
          }),
        )

      const startTurn = (
        backendId: AgentBackendId,
        input: StartTurnInput,
      ): Effect.Effect<AgentTurnResult, AgentBackendError> =>
        requireActiveEntry(backendId).pipe(
          Effect.flatMap((entry) => entry.adapter.startTurn(input)),
        )

      const continueTurn = (
        backendId: AgentBackendId,
        input: ContinueTurnInput,
      ): Effect.Effect<AgentTurnResult, AgentBackendError> =>
        requireActiveEntry(backendId).pipe(
          Effect.flatMap((entry) => entry.adapter.continueTurn(input)),
        )

      const inspectBackend = (
        backendId: AgentBackendId,
        input: InspectInput,
      ): Effect.Effect<InspectResult, AgentBackendError> =>
        requireActiveEntry(backendId).pipe(
          Effect.flatMap((entry) => entry.adapter.inspect(input)),
        )

      const getSessionTelemetry = Effect.fn(
        "ActiveAgentBackend.getSessionTelemetry",
      )(function* (input: {
        readonly backendId: string
        readonly sessionId: string | null
      }) {
        const registration =
          getBuiltInAgentBackend(input.backendId) ??
          resolveActiveRegistration(
            isSelectableAgentBackendId(input.backendId)
              ? input.backendId
              : defaultAgentBackendId,
          )
        const backend = registration.descriptor
        if (!capabilitySupported(registration, "SessionTelemetry")) {
          return unsupportedSessionTelemetry(input.sessionId ?? "", backend)
        }
        if (input.sessionId === null || input.sessionId.trim() === "") {
          return missingSessionTelemetry("", backend)
        }
        const state = yield* Ref.get(stateRef)
        const entry = state.entries.get(registration.descriptor.id)
        if (entry !== undefined) {
          return yield* entry.telemetry.getSession(input.sessionId)
        }
        // Historical provenance for a non-active backend: build telemetry once.
        const runtime = yield* resolveOrUnavailable(registration.descriptor.id)
        return yield* runtime.telemetry.getSession(input.sessionId)
      })

      const activeService = ActiveAgentBackend.of({
        listStatuses,
        getBackendStatus,
        getStatus,
        setSelectedOrInUse,
        activate,
        drop,
        recheck,
        requireAgentTurnsAllowed,
        preview,
        withConfigCoordination,
        getRegistration,
        getActiveRegistration,
        startTurn,
        continueTurn,
        inspectBackend,
        getSessionTelemetry,
      })

      const agentBackendService = AgentBackendService.of({
        inspect: (input) =>
          Ref.get(stateRef).pipe(
            Effect.flatMap((state) => {
              const entry = state.entries.get(state.proxyBackendId)
              if (entry === undefined) {
                return Effect.fail(
                  new AgentBackendConfigError({
                    message: `Agent Backend is not Active: ${state.proxyBackendId}`,
                  }),
                )
              }
              return entry.adapter.inspect(input)
            }),
          ),
        startTurn: (input) =>
          Ref.get(stateRef).pipe(
            Effect.flatMap((state) => {
              const entry = state.entries.get(state.proxyBackendId)
              if (entry === undefined) {
                return Effect.fail(
                  new AgentBackendConfigError({
                    message: `Agent Backend is not Active: ${state.proxyBackendId}`,
                  }),
                )
              }
              return entry.adapter.startTurn(input)
            }),
          ),
        continueTurn: (input) =>
          Ref.get(stateRef).pipe(
            Effect.flatMap((state) => {
              const entry = state.entries.get(state.proxyBackendId)
              if (entry === undefined) {
                return Effect.fail(
                  new AgentBackendConfigError({
                    message: `Agent Backend is not Active: ${state.proxyBackendId}`,
                  }),
                )
              }
              return entry.adapter.continueTurn(input)
            }),
          ),
      })

      const telemetryService = SessionTelemetryProvider.of({
        getSession: (sessionId) =>
          Ref.get(stateRef).pipe(
            Effect.flatMap((state) => {
              const entry = state.entries.get(state.proxyBackendId)
              if (entry === undefined) {
                return Effect.succeed(
                  unsupportedSessionTelemetry(
                    sessionId,
                    descriptorFor(state.proxyBackendId),
                  ),
                )
              }
              return entry.telemetry.getSession(sessionId)
            }),
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
