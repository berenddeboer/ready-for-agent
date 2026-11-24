import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { DbService } from "@ready-for-agent/db-service"

export const persistSessionIdMidRun = (
  workItemId: string,
  sessionId: string,
  repositoryId: string,
): Effect.Effect<void, never, SqlClient.SqlClient | DbService> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const db = yield* DbService
    const rows = yield* sql.unsafe(
      `UPDATE work_item
       SET session_id = ?, updated_at = ?
       WHERE id = ?
         AND (session_id IS NULL OR session_id = '' OR session_id = ?)
       RETURNING id`,
      [sessionId, Date.now(), workItemId, sessionId],
    )
    if (rows[0]) {
      yield* db.notifyWorkItemsChanged(repositoryId)
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Failed to persist Agent session id mid-turn", {
        workItemId,
        sessionId,
        error,
      }),
    ),
    Effect.asVoid,
  )
