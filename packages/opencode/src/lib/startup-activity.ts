import { existsSync } from "node:fs"
import { Duration, Effect } from "effect"
import { Database } from "bun:sqlite"

const DEFAULT_BUSY_TIMEOUT_MS = 250
/** Fast enough to disarm within a short startup window (default 60s; tests use ~200ms). */
const DEFAULT_POLL_INTERVAL = Duration.millis(100)

/**
 * True when OpenCode's session store shows the given parent Session has an
 * active task subagent (or a newly created child session) after `startedAfterMs`.
 *
 * Used to disarm the CLI startup window while the outer `opencode run` JSONL
 * stream stays silent — the parent task part and child session rows are written
 * immediately even though parent stdout waits for the nested task to finish.
 */
export const hasOpencodeTaskSubagentActivity = (
  dbPath: string,
  sessionId: string,
  startedAfterMs: number,
  busyTimeoutMs: number = DEFAULT_BUSY_TIMEOUT_MS,
): boolean => {
  if (sessionId.trim() === "") {
    return false
  }
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    return false
  }

  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true, create: false })
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`)

    const since = Math.trunc(startedAfterMs)

    // Child sessions created after the turn began (task subagents). Use
    // time_created only: time_updated on a historical child (refresh, cost
    // bookkeeping) must not false-disarm the startup window.
    const child = db
      .query(
        `SELECT 1 AS ok
         FROM session
         WHERE parent_id = ?
           AND time_created >= ?
         LIMIT 1`,
      )
      .get(sessionId, since) as { readonly ok: number } | null
    if (child !== null && child !== undefined) {
      return true
    }

    // Parent stream parts for a task / subtask created after the turn began.
    // OpenCode persists these before the nested child emits parent JSONL.
    const part = db
      .query(
        `SELECT 1 AS ok
         FROM part
         WHERE session_id = ?
           AND time_created >= ?
           AND (
             json_extract(data, '$.tool') = 'task'
             OR json_extract(data, '$.type') = 'subtask'
           )
         LIMIT 1`,
      )
      .get(sessionId, since) as { readonly ok: number } | null
    return part !== null && part !== undefined
  } catch {
    return false
  } finally {
    db?.close()
  }
}

export type ObserveOpencodeStartupActivityInput = {
  readonly sessionId: string
  /** Resolve the live OpenCode DB path (may be unavailable until first use). */
  readonly resolveDbPath: () => string | null
  /** Only count activity at or after this epoch ms (just before CLI spawn). */
  readonly startedAfterMs: number
  readonly pollInterval?: Duration.Input
  readonly busyTimeoutMs?: number
}

/**
 * Succeeds when OpenCode session-store activity shows the turn has begun for
 * `sessionId`. Polls until then; never fails (callers ignore probe errors).
 * Interrupted when the runCliTurn scope ends.
 */
export const observeOpencodeStartupActivity = (
  input: ObserveOpencodeStartupActivityInput,
): Effect.Effect<void> => {
  const pollInterval = input.pollInterval ?? DEFAULT_POLL_INTERVAL
  const busyTimeoutMs = input.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  const sessionId = input.sessionId
  const startedAfterMs = input.startedAfterMs

  return Effect.gen(function* () {
    for (;;) {
      const dbPath = input.resolveDbPath()
      if (
        dbPath !== null &&
        hasOpencodeTaskSubagentActivity(
          dbPath,
          sessionId,
          startedAfterMs,
          busyTimeoutMs,
        )
      ) {
        return
      }
      yield* Effect.sleep(pollInterval)
    }
  })
}
