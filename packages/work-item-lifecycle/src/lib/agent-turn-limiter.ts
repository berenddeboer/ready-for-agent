import { Context, Duration, Effect, Option, Ref } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type {
  AgentBackendError,
  AgentTurnResult,
  ContinueTurnInput,
  InspectInput,
  InspectResult,
  StartTurnInput,
} from "@ready-for-agent/agent-backend"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import type { DbServiceShape } from "@ready-for-agent/db-service"
import { STEP_RUN_REASON, WAITING_FOR_AGENT_TURN_MESSAGE } from "./types.js"

const DEFAULT_MAX_CONCURRENT_AGENT_TURNS = 2
const CONFIG_RECHECK_INTERVAL = Duration.millis(200)

export interface AgentBackendService {
  readonly startTurn: (
    input: StartTurnInput,
  ) => Effect.Effect<AgentTurnResult, AgentBackendError>
  readonly continueTurn: (
    input: ContinueTurnInput,
  ) => Effect.Effect<AgentTurnResult, AgentBackendError>
  readonly inspect: (
    input: InspectInput,
  ) => Effect.Effect<InspectResult, AgentBackendError>
}

/**
 * Ambient Step Run identity for the fiber executing a Lifecycle Step handler.
 * Used by the Agent Turn limiter to project mid-run wait state and to admit
 * Agent Turns fairly per Repository.
 */
export type CurrentStepRunValue = {
  readonly stepRunId: string
  readonly repositoryId: string
} | null

export const CurrentStepRun = Context.Reference<CurrentStepRunValue>(
  "@ready-for-agent/work-item-lifecycle/CurrentStepRun",
  { defaultValue: () => null },
)

/**
 * Captured Agent Backend id for the Work Item whose Step Run is executing.
 * Lifecycle sets this for the handler fiber so Agent Turns and Session ops
 * route to the captured adapter instead of re-resolving settings each turn.
 */
export type CurrentCapturedAgentBackendIdValue = string | null

export const CurrentCapturedAgentBackendId =
  Context.Reference<CurrentCapturedAgentBackendIdValue>(
    "@ready-for-agent/work-item-lifecycle/CurrentCapturedAgentBackendId",
    { defaultValue: () => null },
  )

type SavedStepRunReason = {
  readonly reasonCode: string | null
  readonly reasonMessage: string | null
}

/**
 * Bucket used for calls made with no ambient Step Run context (for example
 * direct/test calls). Grouped as a single "repository" so admission among
 * them is unaffected by repository-aware fairness (matches prior behavior).
 */
const NO_REPOSITORY = "@ready-for-agent/work-item-lifecycle/no-repository"

/**
 * Admission state for the repository-aware fair-share gate, extended with an
 * optional per-repository guaranteed-minimum priority claim. `lastGranted`
 * tracks, per repository, the sequence number of the most recent permit it
 * was granted (absent = never granted, treated as the least-recently-serviced
 * of all). `waiting` tracks, per repository, how many callers are currently
 * blocked trying to acquire a permit (pending demand); a repository absent
 * from `waiting` (or with a count of `0`) has no pending demand and is not
 * considered when ranking who goes next. `activeByRepository` tracks, per
 * repository, how many permits it currently holds — used only to evaluate
 * whether `guaranteedMins` is still unmet for that repository.
 * `guaranteedMins` is refreshed opportunistically by each waiting caller from
 * that caller's own Repository settings (mirroring how `capacity` is kept
 * current from Harness Config below), so it converges to the live setting for
 * every repository with active demand without a central scheduler.
 */
type FairGateState = {
  readonly capacity: number
  readonly active: number
  readonly seq: number
  readonly lastGranted: ReadonlyMap<string, number>
  readonly waiting: ReadonlyMap<string, number>
  readonly activeByRepository: ReadonlyMap<string, number>
  readonly guaranteedMins: ReadonlyMap<string, number>
}

const initialFairGateState = (capacity: number): FairGateState => ({
  capacity,
  active: 0,
  seq: 0,
  lastGranted: new Map(),
  waiting: new Map(),
  activeByRepository: new Map(),
  guaranteedMins: new Map(),
})

const recencyOf = (state: FairGateState, repositoryId: string): number =>
  state.lastGranted.get(repositoryId) ?? Number.NEGATIVE_INFINITY

const activeOf = (state: FairGateState, repositoryId: string): number =>
  state.activeByRepository.get(repositoryId) ?? 0

const guaranteedMinOf = (state: FairGateState, repositoryId: string): number =>
  state.guaranteedMins.get(repositoryId) ?? 0

export const pruneIdleRepositoryState =
  (repositoryId: string) =>
  (state: FairGateState): FairGateState => {
    if (
      activeOf(state, repositoryId) > 0 ||
      (state.waiting.get(repositoryId) ?? 0) > 0
    ) {
      return state
    }
    if (
      !state.lastGranted.has(repositoryId) &&
      !state.activeByRepository.has(repositoryId) &&
      !state.guaranteedMins.has(repositoryId)
    ) {
      return state
    }
    const lastGranted = new Map(state.lastGranted)
    const activeByRepository = new Map(state.activeByRepository)
    const guaranteedMins = new Map(state.guaranteedMins)
    lastGranted.delete(repositoryId)
    activeByRepository.delete(repositoryId)
    guaranteedMins.delete(repositoryId)
    return { ...state, lastGranted, activeByRepository, guaranteedMins }
  }

const setGuaranteedMin =
  (repositoryId: string, guaranteedMin: number) =>
  (state: FairGateState): FairGateState => {
    if (guaranteedMinOf(state, repositoryId) === guaranteedMin) {
      return state
    }
    const guaranteedMins = new Map(state.guaranteedMins)
    guaranteedMins.set(repositoryId, guaranteedMin)
    return { ...state, guaranteedMins }
  }

/**
 * Attempt to admit `repositoryId` for one permit. Admits immediately when
 * capacity is free and no other repository with pending demand is more
 * deserving; otherwise leaves the state unchanged so the caller registers as
 * waiting and retries.
 *
 * A repository with an unmet guaranteed minimum (its currently-held permits
 * below its configured `guaranteedMins` floor) is a priority claim ahead of
 * ordinary fair-share rotation: when any contender has an unmet guarantee,
 * only contenders with an unmet guarantee are considered for this permit;
 * otherwise every contender is considered as before. Within whichever pool
 * applies, the least-recently-granted contender wins, so no repository can
 * starve another simply by having steadier demand.
 */
const tryAdmit =
  (repositoryId: string) =>
  (state: FairGateState): [boolean, FairGateState] => {
    if (state.active >= state.capacity) {
      return [false, state]
    }
    const contenders = new Set([repositoryId])
    for (const [otherRepositoryId, count] of state.waiting) {
      if (count > 0) {
        contenders.add(otherRepositoryId)
      }
    }
    const isUnmet = (id: string) =>
      guaranteedMinOf(state, id) > activeOf(state, id)
    const unmet = new Set([...contenders].filter(isUnmet))
    const pool = unmet.size > 0 ? unmet : contenders
    if (!pool.has(repositoryId)) {
      // Another repository's unmet guarantee takes priority over me.
      return [false, state]
    }
    const myRecency = recencyOf(state, repositoryId)
    let leastRecent = myRecency
    for (const contender of pool) {
      leastRecent = Math.min(leastRecent, recencyOf(state, contender))
    }
    if (myRecency > leastRecent) {
      // Another repository in the same pool has gone longer without a
      // permit; let it be considered first.
      return [false, state]
    }
    const lastGranted = new Map(state.lastGranted)
    lastGranted.set(repositoryId, state.seq + 1)
    const activeByRepository = new Map(state.activeByRepository)
    activeByRepository.set(repositoryId, activeOf(state, repositoryId) + 1)
    return [
      true,
      {
        ...state,
        active: state.active + 1,
        seq: state.seq + 1,
        lastGranted,
        activeByRepository,
      },
    ]
  }

const registerWaiting =
  (repositoryId: string) =>
  (state: FairGateState): FairGateState => {
    const waiting = new Map(state.waiting)
    waiting.set(repositoryId, (waiting.get(repositoryId) ?? 0) + 1)
    return { ...state, waiting }
  }

const unregisterWaiting =
  (repositoryId: string) =>
  (state: FairGateState): FairGateState => {
    const count = state.waiting.get(repositoryId) ?? 0
    if (count <= 0) {
      return state
    }
    const waiting = new Map(state.waiting)
    if (count <= 1) {
      waiting.delete(repositoryId)
    } else {
      waiting.set(repositoryId, count - 1)
    }
    return { ...state, waiting }
  }

const releasePermit =
  (repositoryId: string) =>
  (state: FairGateState): FairGateState => {
    const next = Math.max(0, activeOf(state, repositoryId) - 1)
    const activeByRepository = new Map(state.activeByRepository)
    if (next === 0) {
      activeByRepository.delete(repositoryId)
    } else {
      activeByRepository.set(repositoryId, next)
    }
    return pruneIdleRepositoryState(repositoryId)({
      ...state,
      active: Math.max(0, state.active - 1),
      activeByRepository,
    })
  }

/**
 * Cap concurrent lifecycle Agent Turn processes using the current harness
 * Config value, admitting repositories fairly under contention. `inspect` is
 * not wrapped.
 *
 * Re-reads Config on each acquire attempt and resizes the gate's capacity so
 * raising the limit frees capacity promptly and lowering it does not
 * interrupt in-flight processes (they finish; new acquires wait until taken
 * drops).
 *
 * Admission is repository-aware and fair by default: when a permit is free
 * and more than one repository has pending demand (an ambient
 * {@link CurrentStepRun} tagging the caller with a `repositoryId`), the
 * repository that has gone longest without being granted a permit is
 * admitted next. A repository with no pending demand does not affect
 * ordering for the repositories that do, and a single repository (or no
 * contention at all) is admitted immediately exactly as before this
 * repository-aware admission was introduced. Calls with no ambient Step Run
 * context are grouped into one bucket, so their relative admission order is
 * unaffected by this fairness rule. A repository's optional
 * guaranteed-minimum concurrent Agent Turns (Repository setting
 * `guaranteedMinConcurrentAgentTurns`) is honored as a priority claim ahead
 * of fair-share rotation while that repository has an unmet guarantee and
 * pending demand — an idle, unmet guarantee never withholds capacity from
 * other repositories.
 *
 * While waiting for a permit, marks the ambient Step Run with
 * `waiting_for_agent_turn` so GraphQL can show **Queued** instead of
 * **Running**, and records `session_wait_started_at` so max-duration and
 * visibility-lease clocks freeze for the wait. When the slot is acquired,
 * accumulates the wait into `session_wait_ms` and restores any prior mid-run
 * phase (for example Review: pre-commit) instead of clearing the reason.
 */
export const limitAgentTurns = (
  backend: AgentBackendService,
  db: Pick<DbServiceShape, "getConfig" | "notifyWorkItemsChanged">,
  sql: Pick<SqlClient, "unsafe">,
): Effect.Effect<AgentBackendService> =>
  Effect.gen(function* () {
    const gate = yield* Ref.make(
      initialFairGateState(DEFAULT_MAX_CONCURRENT_AGENT_TURNS),
    )

    const currentMax = db.getConfig.pipe(
      Effect.map((config) => Math.max(1, config.maxConcurrentAgentTurns)),
      Effect.orElseSucceed(() => DEFAULT_MAX_CONCURRENT_AGENT_TURNS),
    )

    /** Live Repository guaranteed-minimum concurrent Agent Turns. Missing/null → 0 (fully fair-share). */
    const loadGuaranteedMin = (repositoryId: string): Effect.Effect<number> =>
      repositoryId === NO_REPOSITORY
        ? Effect.succeed(0)
        : sql
            .unsafe(
              `SELECT guaranteed_min_concurrent_agent_turns AS guaranteedMin
               FROM repository WHERE id = ?`,
              [repositoryId],
            )
            .pipe(
              Effect.map((rows) => {
                const row = (
                  rows as readonly { readonly guaranteedMin: number | null }[]
                )[0]
                const raw = row?.guaranteedMin
                return typeof raw === "number" &&
                  Number.isFinite(raw) &&
                  raw > 0
                  ? raw
                  : 0
              }),
              Effect.orElseSucceed(() => 0),
            )

    const markWaiting = (): Effect.Effect<SavedStepRunReason | null> =>
      Effect.gen(function* () {
        const current = yield* CurrentStepRun
        if (current === null) {
          return null
        }
        const rows = (yield* sql.unsafe(
          `SELECT reason_code, reason_message, session_wait_started_at
           FROM step_run
           WHERE id = ? AND status = 'running'`,
          [current.stepRunId],
        )) as readonly {
          readonly reason_code: string | null
          readonly reason_message: string | null
          readonly session_wait_started_at: number | null
        }[]
        const row = rows[0]
        if (row === undefined) {
          return null
        }
        const saved: SavedStepRunReason = {
          reasonCode:
            row.reason_code === STEP_RUN_REASON.waitingForAgentTurn
              ? null
              : row.reason_code,
          reasonMessage:
            row.reason_code === STEP_RUN_REASON.waitingForAgentTurn
              ? null
              : row.reason_message,
        }
        const now = Date.now()
        // Keep the original wait start if already waiting (idempotent re-mark).
        const waitStartedAt = row.session_wait_started_at ?? now
        yield* sql.unsafe(
          `UPDATE step_run
           SET reason_code = ?,
               reason_message = ?,
               session_wait_started_at = ?,
               updated_at = ?
           WHERE id = ?
             AND status = 'running'`,
          [
            STEP_RUN_REASON.waitingForAgentTurn,
            WAITING_FOR_AGENT_TURN_MESSAGE,
            waitStartedAt,
            now,
            current.stepRunId,
          ],
        )
        yield* db.notifyWorkItemsChanged(current.repositoryId)
        return saved
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "Failed to update Agent Turn wait state on Step Run",
            { waiting: true, error },
          ).pipe(Effect.as(null)),
        ),
      )

    const clearWaiting = (
      saved: SavedStepRunReason | null,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const current = yield* CurrentStepRun
        if (current === null) {
          return
        }
        const now = Date.now()
        const rows = (yield* sql.unsafe(
          `SELECT session_wait_started_at, session_wait_ms
           FROM step_run
           WHERE id = ?
             AND status = 'running'
             AND reason_code = ?`,
          [current.stepRunId, STEP_RUN_REASON.waitingForAgentTurn],
        )) as readonly {
          readonly session_wait_started_at: number | null
          readonly session_wait_ms: number | null
        }[]
        const row = rows[0]
        if (row === undefined) {
          return
        }
        const openWaitMs =
          row.session_wait_started_at === null
            ? 0
            : Math.max(0, now - row.session_wait_started_at)
        const sessionWaitMs = Math.max(0, row.session_wait_ms ?? 0) + openWaitMs
        yield* sql.unsafe(
          `UPDATE step_run
           SET reason_code = ?,
               reason_message = ?,
               session_wait_ms = ?,
               session_wait_started_at = NULL,
               updated_at = ?
           WHERE id = ?
             AND status = 'running'
             AND reason_code = ?`,
          [
            saved?.reasonCode ?? null,
            saved?.reasonMessage ?? null,
            sessionWaitMs,
            now,
            current.stepRunId,
            STEP_RUN_REASON.waitingForAgentTurn,
          ],
        )
        yield* db.notifyWorkItemsChanged(current.repositoryId)
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "Failed to update Agent Turn wait state on Step Run",
            { waiting: false, error },
          ),
        ),
        Effect.asVoid,
      )

    const withTurnSlot = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const current = yield* CurrentStepRun
        const repositoryId = current?.repositoryId ?? NO_REPOSITORY

        let markedWaiting = false
        let savedReason: SavedStepRunReason | null = null
        let registeredWaiting = false

        const unregisterWaitingIfNeeded = Effect.gen(function* () {
          if (registeredWaiting) {
            yield* Ref.update(gate, unregisterWaiting(repositoryId))
            registeredWaiting = false
          }
        })

        const clearMarkedWaitingIfNeeded = Effect.gen(function* () {
          if (markedWaiting) {
            yield* clearWaiting(savedReason)
            markedWaiting = false
            savedReason = null
          }
        })

        const cleanupWaiting = Effect.gen(function* () {
          yield* unregisterWaitingIfNeeded
          yield* clearMarkedWaitingIfNeeded
        })

        // Admitting this caller and pairing its permit with a guaranteed
        // release must never straddle an interruption boundary: an interrupt
        // that lands between "permit taken" and "release wired up" would
        // leak that permit for the rest of the process's life. This mirrors
        // how Effect's own `Semaphore.withPermitsIfAvailable` couples taking
        // a permit with registering its release inside one uninterruptible
        // region. Only the admission attempt itself (the `Ref.modify` below)
        // must be uninterruptible; everything else — the config re-check and
        // the waiting bookkeeping in the loop below, and the wait-state reset
        // (including `clearWaiting`'s best-effort SQL write) and the turn
        // itself here — stays freely interruptible exactly as it was before
        // repository-aware fairness, all covered by the same guaranteed
        // release. So a Step Run that is merely queued — never admitted —
        // can still be cancelled promptly by Pause, Interrupt Work Item, or
        // a productive timeout even if the database is slow, and a Step Run
        // that was just admitted keeps that same promptness through its
        // wait-state reset.
        const tryRunTurn: Effect.Effect<
          Option.Option<A>,
          E,
          R
        > = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const admitted = yield* Ref.modify(gate, tryAdmit(repositoryId))
            if (!admitted) {
              return Option.none()
            }
            const result = yield* restore(
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* cleanupWaiting
                  return yield* effect
                }),
                Ref.update(gate, releasePermit(repositoryId)),
              ),
            )
            return Option.some(result)
          }),
        )

        const runTurn = Effect.gen(function* () {
          for (;;) {
            const max = yield* currentMax
            const guaranteedMin = yield* loadGuaranteedMin(repositoryId)
            yield* Ref.update(gate, (state) =>
              setGuaranteedMin(
                repositoryId,
                guaranteedMin,
              )({ ...state, capacity: max }),
            )
            const result = yield* tryRunTurn
            if (Option.isSome(result)) {
              return result.value
            }
            if (!registeredWaiting) {
              yield* Ref.update(gate, registerWaiting(repositoryId))
              registeredWaiting = true
            }
            if (!markedWaiting) {
              savedReason = yield* markWaiting()
              markedWaiting = true
            }
            yield* Effect.sleep(CONFIG_RECHECK_INTERVAL)
          }
        })

        // If interrupted while merely waiting, always remove in-memory demand.
        // Restoring interruptibility around the best-effort SQL cleanup keeps
        // a stalled database from blocking Pause/Interrupt indefinitely.
        return yield* runTurn.pipe(
          Effect.onExit(() =>
            Effect.gen(function* () {
              yield* unregisterWaitingIfNeeded
              yield* Ref.update(gate, pruneIdleRepositoryState(repositoryId))
              yield* clearMarkedWaitingIfNeeded.pipe(Effect.interruptible)
            }),
          ),
        )
      })

    return AgentBackend.of({
      startTurn: (input) => withTurnSlot(backend.startTurn(input)),
      continueTurn: (input) => withTurnSlot(backend.continueTurn(input)),
      inspect: (input) => backend.inspect(input),
    })
  })
