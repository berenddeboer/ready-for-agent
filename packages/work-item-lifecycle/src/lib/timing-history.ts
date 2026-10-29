import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { LIFECYCLE_STEP_AGENT_FREE } from "@ready-for-agent/lifecycle-model"
import { WorkItemLifecycleDatabaseError } from "./errors.js"

export const TIMING_AGENT_BACKEND_MAX_LENGTH = 64
export const TIMING_MODEL_MAX_LENGTH = 2048

export type TimingHistoryFilter = {
  readonly repositoryId: string | null
  readonly fromMs: number | null
  readonly toMs: number
  /** Captured Work Item Agent Backend. Null means all backends. */
  readonly agentBackend: string | null
  /** Recorded model id. Null means all models, unless unknownModel is set. */
  readonly model: string | null
  /** Work Items with no recorded historical model identity. */
  readonly unknownModel: boolean
}

export type TimingModelHistory = "unknown" | "partial" | "complete"

export type TimingModelChoice = {
  readonly agentBackend: string
  readonly model: string
}

const TimingRow = Schema.Struct({
  id: Schema.String,
  repositoryId: Schema.String,
  repository: Schema.String,
  displayId: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  origin: Schema.String,
  agentBackend: Schema.String,
  modelsJson: Schema.NullOr(Schema.String),
  agentStepsMissingModel: Schema.Number,
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
  | "agentBackend"
  | "createdAt"
  | "completedAt"
> & {
  readonly models: readonly string[]
  readonly modelHistory: TimingModelHistory
  readonly attempts: TimingAttempt[]
}
export type TimingHistory = readonly TimingWorkItem[]

export type TimingHistoryChoices = {
  readonly agentBackends: readonly string[]
  readonly models: readonly TimingModelChoice[]
  readonly hasUnknownModel: boolean
}

export type TimingHistoryResult = {
  readonly items: TimingHistory
  readonly choices: TimingHistoryChoices
}

const ChoiceBackendRow = Schema.Struct({ agentBackend: Schema.String })
const ChoiceModelRow = Schema.Struct({
  agentBackend: Schema.String,
  model: Schema.String,
})
const UnknownRow = Schema.Struct({
  hasUnknownModel: Schema.Union([Schema.Number, Schema.Boolean]),
})
const ModelList = Schema.Array(Schema.String)

/** Agent-free steps do not make model history partial when they have no row. */
export const agentFreeLifecycleSteps = (): readonly string[] =>
  Object.entries(LIFECYCLE_STEP_AGENT_FREE).flatMap(([step, free]) =>
    free ? [step] : [],
  )

const agentFreeStepSql = () =>
  agentFreeLifecycleSteps()
    .map((step) => `'${step}'`)
    .join(", ")

const databaseError = (message: string, cause: unknown) =>
  new WorkItemLifecycleDatabaseError({ message, cause })

const decodeModels = (
  raw: string | null,
): Effect.Effect<readonly string[], WorkItemLifecycleDatabaseError> => {
  if (raw === null) {
    return Effect.succeed([])
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    return Effect.fail(
      databaseError("Could not parse recorded Agent Model history", cause),
    )
  }
  return Schema.decodeUnknownEffect(ModelList)(parsed).pipe(
    Effect.mapError((cause) =>
      databaseError(
        "Recorded Agent Model history was not a string list",
        cause,
      ),
    ),
  )
}

const modelHistoryFor = (
  models: readonly string[],
  agentStepsMissingModel: number,
): TimingModelHistory => {
  if (models.length === 0) {
    return "unknown"
  }
  return agentStepsMissingModel > 0 ? "partial" : "complete"
}

const isUnknownFlag = (value: number | boolean) => value === true || value === 1

/**
 * Narrow read model: no diagnostics, transcripts, live Forge calls, live Agent
 * catalogs, or current settings. Complete only. One statement gives a consistent
 * cohort and all its attempts, including attempts before the completion window.
 * Model matching uses existence predicates so multiple recorded models do not
 * multiply attempts.
 */
export const loadTimingHistory = Effect.fn("WorkItemLifecycle.timingHistory")(
  function* (
    sql: SqlClient.SqlClient,
    filter: TimingHistoryFilter,
  ): Effect.fn.Return<TimingHistoryResult, WorkItemLifecycleDatabaseError> {
    const basePredicates = ["wi.state = 'complete'", "wi.state_ready_at < ?"]
    const baseParameters: (string | number)[] = [filter.toMs]
    if (filter.fromMs !== null) {
      basePredicates.push("wi.state_ready_at >= ?")
      baseParameters.push(filter.fromMs)
    }
    if (filter.repositoryId !== null) {
      basePredicates.push("wi.repository_id = ?")
      baseParameters.push(filter.repositoryId)
    }
    const where = basePredicates.join(" AND ")
    const cohortFrom = `FROM work_item wi INNER JOIN repository r ON r.id = wi.repository_id`

    const itemPredicates = [...basePredicates]
    const itemParameters = [...baseParameters]
    if (filter.agentBackend !== null) {
      itemPredicates.push("wi.agent_backend = ?")
      itemParameters.push(filter.agentBackend)
    }
    if (filter.unknownModel) {
      itemPredicates.push(`NOT EXISTS (
        SELECT 1 FROM step_run sr_model
        INNER JOIN step_run_agent_model m ON m.step_run_id = sr_model.id
        WHERE sr_model.work_item_id = wi.id
      )`)
    } else if (filter.model !== null) {
      itemPredicates.push(`EXISTS (
        SELECT 1 FROM step_run sr_model
        INNER JOIN step_run_agent_model m ON m.step_run_id = sr_model.id
        WHERE sr_model.work_item_id = wi.id AND m.model = ?
      )`)
      itemParameters.push(filter.model)
    }

    const rows = yield* sql
      .unsafe(
        `
      SELECT wi.id, wi.repository_id AS repositoryId, r.project_path AS repository,
        COALESCE(wi.issue_display_id, CAST(wi.issue_number AS TEXT)) AS displayId,
        wi.issue_title AS title, wi.origin, wi.agent_backend AS agentBackend,
        wi.created_at AS createdAt, wi.state_ready_at AS completedAt,
        (
          SELECT json_group_array(model) FROM (
            SELECT DISTINCT m.model AS model
            FROM step_run sr_m
            INNER JOIN step_run_agent_model m ON m.step_run_id = sr_m.id
            WHERE sr_m.work_item_id = wi.id
            ORDER BY m.model
          )
        ) AS modelsJson,
        (
          SELECT COUNT(*)
          FROM step_run sr_missing
          WHERE sr_missing.work_item_id = wi.id
            AND sr_missing.started_at IS NOT NULL
            AND sr_missing.step NOT IN (${agentFreeStepSql()})
            AND NOT EXISTS (
              SELECT 1 FROM step_run_agent_model m
              WHERE m.step_run_id = sr_missing.id
            )
        ) AS agentStepsMissingModel,
        sr.id AS runId, sr.step, sr.status,
        sr.queued_at AS queuedAt, sr.started_at AS startedAt,
        sr.finished_at AS finishedAt, sr.session_wait_ms AS sessionWaitMs,
        sr.reason_code AS reasonCode
      ${cohortFrom}
      LEFT JOIN step_run sr ON sr.work_item_id = wi.id
      WHERE ${itemPredicates.join(" AND ")}
      ORDER BY wi.state_ready_at DESC, wi.id, sr.queued_at, sr.rowid
    `,
        itemParameters,
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(TimingRow))),
        Effect.mapError((cause) =>
          databaseError(
            "Could not read completed Work Item timing history",
            cause,
          ),
        ),
      )
    const backendRows = yield* sql
      .unsafe(
        `SELECT DISTINCT wi.agent_backend AS agentBackend
       ${cohortFrom}
       WHERE ${where}
       ORDER BY wi.agent_backend`,
        baseParameters,
      )
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Array(ChoiceBackendRow)),
        ),
        Effect.mapError((cause) =>
          databaseError(
            "Could not read historical Agent Backend choices",
            cause,
          ),
        ),
      )
    const modelRows = yield* sql
      .unsafe(
        `SELECT DISTINCT wi.agent_backend AS agentBackend, m.model AS model
       ${cohortFrom}
       INNER JOIN step_run sr ON sr.work_item_id = wi.id
       INNER JOIN step_run_agent_model m ON m.step_run_id = sr.id
       WHERE ${where}
       ORDER BY wi.agent_backend, m.model`,
        baseParameters,
      )
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Array(ChoiceModelRow)),
        ),
        Effect.mapError((cause) =>
          databaseError("Could not read historical Agent Model choices", cause),
        ),
      )
    const unknownRows = yield* sql
      .unsafe(
        `SELECT EXISTS (
         SELECT 1 ${cohortFrom}
         WHERE ${where}
           AND NOT EXISTS (
             SELECT 1 FROM step_run sr_model
             INNER JOIN step_run_agent_model m ON m.step_run_id = sr_model.id
             WHERE sr_model.work_item_id = wi.id
           )
       ) AS hasUnknownModel`,
        baseParameters,
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(UnknownRow))),
        Effect.mapError((cause) =>
          databaseError("Could not read unknown Agent Model history", cause),
        ),
      )

    const items = new Map<string, TimingWorkItem>()
    for (const row of rows) {
      let item = items.get(row.id)
      if (item === undefined) {
        const models = yield* decodeModels(row.modelsJson)
        item = {
          id: row.id,
          repositoryId: row.repositoryId,
          repository: row.repository,
          displayId: row.displayId,
          title: row.title,
          origin: row.origin,
          agentBackend: row.agentBackend,
          models,
          modelHistory: modelHistoryFor(models, row.agentStepsMissingModel),
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
    return {
      items: [...items.values()],
      choices: {
        agentBackends: backendRows.map((row) => row.agentBackend),
        models: modelRows,
        hasUnknownModel: isUnknownFlag(
          unknownRows[0]?.hasUnknownModel ?? false,
        ),
      },
    }
  },
)
