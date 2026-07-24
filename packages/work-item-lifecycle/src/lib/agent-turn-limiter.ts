import { Context, Duration, Effect, Option, Semaphore } from "effect"
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
 * Used by the Agent Turn limiter to project mid-run wait state.
 */
export type CurrentStepRunValue = {
  readonly stepRunId: string
  readonly repositoryId: string
} | null

export const CurrentStepRun = Context.Reference<CurrentStepRunValue>(
  "@ready-for-agent/work-item-lifecycle/CurrentStepRun",
  { defaultValue: () => null },
)

type SavedStepRunReason = {
  readonly reasonCode: string | null
  readonly reasonMessage: string | null
}

/**
 * Cap concurrent lifecycle Agent Turn processes using the current harness
 * Config value. `inspect` is not wrapped.
 *
 * Re-reads Config on each acquire attempt and resizes the semaphore so raising
 * the limit frees capacity promptly and lowering it does not interrupt
 * in-flight processes (they finish; new acquires wait until taken drops).
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
    const semaphore = yield* Semaphore.make(DEFAULT_MAX_CONCURRENT_AGENT_TURNS)

    const currentMax = db.getConfig.pipe(
      Effect.map((config) => Math.max(1, config.maxConcurrentAgentTurns)),
      Effect.orElseSucceed(() => DEFAULT_MAX_CONCURRENT_AGENT_TURNS),
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
        let markedWaiting = false
        let savedReason: SavedStepRunReason | null = null
        for (;;) {
          const max = yield* currentMax
          yield* semaphore.resize(max)
          const result = yield* semaphore.withPermitsIfAvailable(1)(
            Effect.gen(function* () {
              if (markedWaiting) {
                yield* clearWaiting(savedReason)
                markedWaiting = false
                savedReason = null
              }
              return yield* effect
            }),
          )
          if (Option.isSome(result)) {
            return result.value
          }
          if (!markedWaiting) {
            savedReason = yield* markWaiting()
            markedWaiting = true
          }
          yield* Effect.sleep(CONFIG_RECHECK_INTERVAL)
        }
      })

    return AgentBackend.of({
      startTurn: (input) => withTurnSlot(backend.startTurn(input)),
      continueTurn: (input) => withTurnSlot(backend.continueTurn(input)),
      inspect: (input) => backend.inspect(input),
    })
  })
