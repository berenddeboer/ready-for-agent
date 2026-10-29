import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { WorkItemLifecycleDatabaseError } from "./errors.js"

export type TimingHistoryFilter = {
  readonly repositoryId: string | null
  readonly fromMs: number | null
  readonly toMs: number
}

const TimingRow = Schema.Struct({
  id: Schema.String,
  repositoryId: Schema.String,
  repository: Schema.String,
  displayId: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  origin: Schema.String,
  createdAt: Schema.Number,
  completedAt: Schema.Number,
  runId: Schema.NullOr(Schema.String),
  step: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  queuedAt: Schema.NullOr(Schema.Number),
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  sessionWaitMs: Schema.NullOr(Schema.Number),
  reasonCode: Schema.NullOr(Schema.String),
})

type Row = typeof TimingRow.Type
type TimingAttempt = {
  readonly id: string
  readonly step: string
  readonly status: string
  readonly queuedAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly sessionWaitMs: number
  readonly reasonCode: string | null
}
type TimingWorkItem = Pick<
  Row,
  | "id"
  | "repositoryId"
  | "repository"
  | "displayId"
  | "title"
  | "origin"
  | "createdAt"
  | "completedAt"
> & {
  readonly attempts: TimingAttempt[]
}
export type TimingHistory = readonly TimingWorkItem[]

/** Narrow read model: no diagnostics, transcripts, live Forge calls, or N+1 reads.
 * Complete only (not the archive's broader Complete + Abandoned category).
 * A single statement gives a consistent cohort and all its attempts, including
 * attempts before the completion window. No sampling or hidden history cap.
 */
export const loadTimingHistory = Effect.fn("WorkItemLifecycle.timingHistory")(
  function* (sql: SqlClient.SqlClient, filter: TimingHistoryFilter) {
    const predicates = ["wi.state = 'complete'", "wi.state_ready_at < ?"]
    const parameters: (string | number)[] = [filter.toMs]
    if (filter.fromMs !== null) {
      predicates.push("wi.state_ready_at >= ?")
      parameters.push(filter.fromMs)
    }
    if (filter.repositoryId !== null) {
      predicates.push("wi.repository_id = ?")
      parameters.push(filter.repositoryId)
    }
    const rows = yield* sql
      .unsafe(
        `
      SELECT wi.id, wi.repository_id AS repositoryId, r.project_path AS repository,
        COALESCE(wi.issue_display_id, CAST(wi.issue_number AS TEXT)) AS displayId,
        wi.issue_title AS title, wi.origin, wi.created_at AS createdAt,
        wi.state_ready_at AS completedAt, sr.id AS runId, sr.step, sr.status,
        sr.queued_at AS queuedAt, sr.started_at AS startedAt,
        sr.finished_at AS finishedAt, sr.session_wait_ms AS sessionWaitMs,
        sr.reason_code AS reasonCode
      FROM work_item wi
      INNER JOIN repository r ON r.id = wi.repository_id
      LEFT JOIN step_run sr ON sr.work_item_id = wi.id
      WHERE ${predicates.join(" AND ")}
      ORDER BY wi.state_ready_at DESC, wi.id, sr.queued_at, sr.rowid
    `,
        parameters,
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TimingRow))),
        Effect.mapError(
          (cause) =>
            new WorkItemLifecycleDatabaseError({
              message: "Could not read completed Work Item timing history",
              cause,
            }),
        ),
      )
    const items = new Map<string, TimingWorkItem>()
    for (const row of rows) {
      let item = items.get(row.id)
      if (item === undefined) {
        item = {
          id: row.id,
          repositoryId: row.repositoryId,
          repository: row.repository,
          displayId: row.displayId,
          title: row.title,
          origin: row.origin,
          createdAt: row.createdAt,
          completedAt: row.completedAt,
          attempts: [],
        }
        items.set(item.id, item)
      }
      if (
        row.runId !== null &&
        row.step !== null &&
        row.status !== null &&
        row.queuedAt !== null
      ) {
        item.attempts.push({
          id: row.runId,
          step: row.step,
          status: row.status,
          queuedAt: row.queuedAt,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          sessionWaitMs: row.sessionWaitMs ?? 0,
          reasonCode: row.reasonCode,
        })
      }
    }
    return [...items.values()]
  },
)
