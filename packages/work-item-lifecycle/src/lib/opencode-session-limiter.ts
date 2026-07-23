import { Context, Duration, Effect, Option, Semaphore } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { DbServiceShape } from "@ready-for-agent/db-service"
import type {
  ContinueInput,
  ListModelsInput,
  OpencodeError,
  OpencodeModel,
  OpencodeRunResult,
  StartInput,
} from "@ready-for-agent/opencode"
import { Opencode } from "@ready-for-agent/opencode"
import {
  STEP_RUN_REASON,
  WAITING_FOR_OPENCODE_SESSION_MESSAGE,
} from "./types.js"

const DEFAULT_MAX_CONCURRENT_OPENCODE_SESSIONS = 2
const CONFIG_RECHECK_INTERVAL = Duration.millis(200)

export interface OpencodeService {
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<OpencodeRunResult, OpencodeError>
  readonly continue: (
    input: ContinueInput,
  ) => Effect.Effect<OpencodeRunResult, OpencodeError>
  readonly listModels: (
    input: ListModelsInput,
  ) => Effect.Effect<ReadonlyArray<OpencodeModel>, OpencodeError>
}

/**
 * Ambient Step Run identity for the fiber executing a Lifecycle Step handler.
 * Used by the OpenCode session limiter to project mid-run wait state.
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
 * Cap concurrent lifecycle OpenCode `start`/`continue` processes using the
 * current harness Config value. `listModels` is not wrapped.
 *
 * Re-reads Config on each acquire attempt and resizes the semaphore so raising
 * the limit frees capacity promptly and lowering it does not interrupt
 * in-flight processes (they finish; new acquires wait until taken drops).
 *
 * While waiting for a permit, marks the ambient Step Run with
 * `waiting_for_opencode_session` so GraphQL can show **Queued** instead of
 * **Running**. When the slot is acquired, restores any prior mid-run phase
 * (for example Review: pre-commit) instead of clearing the reason.
 */
export const limitOpencodeSessions = (
  opencode: OpencodeService,
  db: Pick<DbServiceShape, "getConfig" | "notifyWorkItemsChanged">,
  sql: Pick<SqlClient, "unsafe">,
): Effect.Effect<OpencodeService> =>
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(
      DEFAULT_MAX_CONCURRENT_OPENCODE_SESSIONS,
    )

    const currentMax = db.getConfig.pipe(
      Effect.map((config) => Math.max(1, config.maxConcurrentOpencodeSessions)),
      Effect.orElseSucceed(() => DEFAULT_MAX_CONCURRENT_OPENCODE_SESSIONS),
    )

    const markWaiting = (): Effect.Effect<SavedStepRunReason | null> =>
      Effect.gen(function* () {
        const current = yield* CurrentStepRun
        if (current === null) {
          return null
        }
        const rows = (yield* sql.unsafe(
          `SELECT reason_code, reason_message FROM step_run
           WHERE id = ? AND status = 'running'`,
          [current.stepRunId],
        )) as readonly {
          readonly reason_code: string | null
          readonly reason_message: string | null
        }[]
        const row = rows[0]
        if (row === undefined) {
          return null
        }
        const saved: SavedStepRunReason = {
          reasonCode:
            row.reason_code === STEP_RUN_REASON.waitingForOpencodeSession
              ? null
              : row.reason_code,
          reasonMessage:
            row.reason_code === STEP_RUN_REASON.waitingForOpencodeSession
              ? null
              : row.reason_message,
        }
        const now = Date.now()
        yield* sql.unsafe(
          `UPDATE step_run
           SET reason_code = ?,
               reason_message = ?,
               updated_at = ?
           WHERE id = ?
             AND status = 'running'`,
          [
            STEP_RUN_REASON.waitingForOpencodeSession,
            WAITING_FOR_OPENCODE_SESSION_MESSAGE,
            now,
            current.stepRunId,
          ],
        )
        yield* db.notifyWorkItemsChanged(current.repositoryId)
        return saved
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "Failed to update OpenCode session wait state on Step Run",
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
        yield* sql.unsafe(
          `UPDATE step_run
           SET reason_code = ?,
               reason_message = ?,
               updated_at = ?
           WHERE id = ?
             AND status = 'running'
             AND reason_code = ?`,
          [
            saved?.reasonCode ?? null,
            saved?.reasonMessage ?? null,
            now,
            current.stepRunId,
            STEP_RUN_REASON.waitingForOpencodeSession,
          ],
        )
        yield* db.notifyWorkItemsChanged(current.repositoryId)
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "Failed to update OpenCode session wait state on Step Run",
            { waiting: false, error },
          ),
        ),
        Effect.asVoid,
      )

    const withSessionSlot = <A, E, R>(
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

    return Opencode.of({
      start: (input) => withSessionSlot(opencode.start(input)),
      continue: (input) => withSessionSlot(opencode.continue(input)),
      listModels: (input) => opencode.listModels(input),
    })
  })
