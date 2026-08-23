import { Clock, Context, Effect, Layer, PubSub, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { ulid } from "ulidx"
import { isSelectableAgentBackendId } from "@ready-for-agent/agent-backend"
import {
  AgentBackendChangeBlockedError,
  DatabaseError,
  GuaranteedMinAgentTurnsExceedsCapError,
  InvalidConfigInputError,
  InvalidIssueInputError,
  InvalidRepositoryInputError,
  InvalidRepositorySettingsError,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
  RepositoryHasRunningStepError,
  RepositoryIdentityChangeBlockedError,
  RepositoryNotFoundError,
} from "./errors.js"
import {
  type AddRepositoryInput,
  type BackendModelPrefs,
  ConfigRecord,
  ConfigSqlRow,
  type IssueDependency,
  IssueDependencySqlRow,
  IssueRecord,
  IssueSqlRow,
  RepositoryId,
  RepositoryRecord,
  RepositorySqlRow,
  RunningStepSqlRow,
  type StoreIssueInput,
  UnfinishedCreatePrWorkItem,
  UnfinishedCreatePrWorkItemSqlRow,
  type UpdateConfigInput,
  type UpdateRepositorySettingsInput,
  WorkItemPullRequest,
  WorkItemPullRequestSqlRow,
  emptyBackendModelPrefs,
} from "./types.js"

type BackendModelPrefsMap = Record<string, BackendModelPrefs>

const parseBackendModelPrefsMap = (raw: string): BackendModelPrefsMap => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {}
    }
    const out: BackendModelPrefsMap = {}
    for (const [backendId, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        continue
      }
      const entry = value as Record<string, unknown>
      const asOptionalString = (field: unknown): string | null =>
        typeof field === "string" && field.trim().length > 0
          ? field.trim()
          : null
      out[backendId] = {
        defaultModel: asOptionalString(entry.defaultModel),
        defaultThinkingLevel: asOptionalString(entry.defaultThinkingLevel),
        reviewModel: asOptionalString(entry.reviewModel),
        reviewThinkingLevel: asOptionalString(entry.reviewThinkingLevel),
      }
    }
    return out
  } catch {
    return {}
  }
}

const serializeBackendModelPrefsMap = (map: BackendModelPrefsMap): string =>
  JSON.stringify(map)

const prefsForBackend = (
  map: BackendModelPrefsMap,
  backendId: string,
): BackendModelPrefs => map[backendId] ?? emptyBackendModelPrefs()

const formatSqlError = (error: SqlError): string => {
  const parts: string[] = [error.message]

  let current: unknown = error.cause
  while (current) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>
      if ("message" in obj && typeof obj["message"] === "string") {
        parts.push(obj["message"])
      }
      current = "cause" in obj ? obj["cause"] : undefined
    } else if (typeof current === "string") {
      parts.push(current)
      break
    } else {
      break
    }
  }

  return parts.join(" -> ")
}

const isUniqueConstraint = (error: SqlError): boolean => {
  const message = formatSqlError(error).toLowerCase()
  return (
    message.includes("unique") ||
    message.includes("constraint") ||
    message.includes("sqlite_constraint")
  )
}

const trimRequired = (
  value: string,
  field: "forgeHost" | "projectPath" | "localPath",
): Effect.Effect<string, InvalidRepositoryInputError> => {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return Effect.fail(
      new InvalidRepositoryInputError({
        field,
        message: `${field} cannot be empty`,
      }),
    )
  }
  return Effect.succeed(trimmed)
}

const normalizeOptionalSetting = (
  value: string | null,
): Effect.Effect<string | null, InvalidRepositorySettingsError> => {
  if (value === null) {
    return Effect.succeed(null)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return Effect.succeed(null)
  }
  return Effect.succeed(trimmed)
}

const normalizeRequiredRepositorySetting = (
  value: string,
  field: "forgeHost" | "projectPath",
): Effect.Effect<string, InvalidRepositorySettingsError> => {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return Effect.fail(
      new InvalidRepositorySettingsError({
        field,
        message: `${field} cannot be empty`,
      }),
    )
  }
  return Effect.succeed(field === "forgeHost" ? trimmed.toLowerCase() : trimmed)
}

const normalizeOptionalConfigSetting = (
  value: string | null,
): Effect.Effect<string | null, InvalidConfigInputError> => {
  if (value === null) {
    return Effect.succeed(null)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return Effect.succeed(null)
  }
  return Effect.succeed(trimmed)
}

/**
 * Unfinished Work Items include Needs Human, paused, and Waiting for Worker
 * Slot. Terminal complete/failed/abandoned do not.
 */
const isUnfinishedStateSql = (column = "state") =>
  `${column} NOT IN ('complete', 'failed', 'abandoned')`

/**
 * Backend-change gates count only unfinished ordinary Work Items. An Explicit
 * Work Item Execution Profile is immutable, so those Work Items do not block
 * Repository or Harness default backend changes.
 */
const isSettingsResolvedUnfinishedSql = (tableAlias?: string) => {
  const stateColumn = tableAlias === undefined ? "state" : `${tableAlias}.state`
  const profileColumn =
    tableAlias === undefined
      ? "execution_profile_present"
      : `${tableAlias}.execution_profile_present`
  return `${isUnfinishedStateSql(stateColumn)} AND ${profileColumn} = 0`
}

/**
 * Normalize a Repository Agent Backend override. Empty/whitespace → null
 * (inherit). Non-null must be a selectable built-in backend id.
 */
const normalizeRepositoryAgentBackendOverride = (
  value: string | null,
): Effect.Effect<string | null, InvalidRepositorySettingsError> => {
  if (value === null) {
    return Effect.succeed(null)
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return Effect.succeed(null)
  }
  if (!isSelectableAgentBackendId(trimmed)) {
    return Effect.fail(
      new InvalidRepositorySettingsError({
        field: "selectedAgentBackend",
        message: `Unknown Agent Backend: ${trimmed}`,
      }),
    )
  }
  return Effect.succeed(trimmed)
}

const effectiveAgentBackend = (
  repositoryOverride: string | null,
  harnessDefault: string,
): string => repositoryOverride ?? harnessDefault

/**
 * Normalize a Repository guaranteed-minimum concurrent Agent Turns floor.
 * Null clears the guarantee (fully fair-share). Non-null must be a
 * non-negative integer.
 */
const normalizeGuaranteedMinAgentTurns = (
  value: number | null,
): Effect.Effect<number | null, InvalidRepositorySettingsError> => {
  if (value === null) {
    return Effect.succeed(null)
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return Effect.fail(
      new InvalidRepositorySettingsError({
        field: "guaranteedMinConcurrentAgentTurns",
        message:
          "guaranteedMinConcurrentAgentTurns must be a non-negative integer",
      }),
    )
  }
  return Effect.succeed(value)
}

const toDatabaseError = (error: SqlError) =>
  new DatabaseError({
    message: `Database error: ${formatSqlError(error)}`,
    cause: error,
  })

const toSchemaDatabaseError = (error: Schema.SchemaError) =>
  new DatabaseError({
    message: `Database row shape error: ${error.message}`,
    cause: error,
  })

const decodeRepositoryRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(RepositorySqlRow))(rows).pipe(
    Effect.mapError(toSchemaDatabaseError),
  )
const decodeConfigRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(ConfigSqlRow))(rows).pipe(
    Effect.mapError(toSchemaDatabaseError),
  )
const decodeIssueRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(IssueSqlRow))(rows).pipe(
    Effect.mapError(toSchemaDatabaseError),
  )
const decodeIssueDependencyRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(IssueDependencySqlRow))(rows).pipe(
    Effect.mapError(toSchemaDatabaseError),
  )
const decodeUnfinishedCreatePrWorkItemRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(UnfinishedCreatePrWorkItemSqlRow))(
    rows,
  ).pipe(Effect.mapError(toSchemaDatabaseError))

const decodeWorkItemPullRequestRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(WorkItemPullRequestSqlRow))(
    rows,
  ).pipe(Effect.mapError(toSchemaDatabaseError))
const decodeRunningStepRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(RunningStepSqlRow))(rows).pipe(
    Effect.mapError(toSchemaDatabaseError),
  )

const repositorySelectColumns = `id, forge, forge_host, project_path, local_path, is_bare, paused,
             selected_agent_backend, default_model, default_thinking_level,
             review_model, review_thinking_level, backend_model_prefs, merge_policy,
             guaranteed_min_concurrent_agent_turns,
             include_all_issue_authors, wait_for_ready_for_review_checks,
             issues_reconciled_at`

const issueSelectColumns = `id, repository_id, issue_number, title, body, url, state,
                github_created_at, issue_author, parent_issue_number,
                parent_issue_url, parent_position, has_children`

const toRepositoryRecord = (row: RepositorySqlRow): RepositoryRecord =>
  RepositoryRecord.make({
    id: row.id,
    forge: row.forge,
    forgeHost: row.forgeHost,
    projectPath: row.projectPath,
    localPath: row.localPath,
    isBare: row.isBare,
    paused: row.paused,
    selectedAgentBackend: row.selectedAgentBackend,
    defaultModel: row.defaultModel,
    defaultThinkingLevel: row.defaultThinkingLevel,
    reviewModel: row.reviewModel,
    reviewThinkingLevel: row.reviewThinkingLevel,
    mergePolicy: row.mergePolicy,
    guaranteedMinConcurrentAgentTurns: row.guaranteedMinConcurrentAgentTurns,
    includeAllIssueAuthors: row.includeAllIssueAuthors,
    waitForReadyForReviewChecks: row.waitForReadyForReviewChecks,
    issuesReconciledAt: row.issuesReconciledAt,
  })

const toIssueRecord = (
  row: IssueSqlRow,
  blockedBy: readonly IssueDependency[],
): IssueRecord => ({
  id: row.id,
  repositoryId: row.repositoryId,
  issueNumber: row.issueNumber,
  title: row.title,
  body: row.body,
  url: row.url,
  state: row.state,
  githubCreatedAt: new Date(row.githubCreatedAt),
  issueAuthor: row.issueAuthor,
  parentPosition: row.parentPosition,
  hasChildren: row.hasChildren,
  parent:
    row.parentIssueNumber === null || row.parentIssueUrl === null
      ? null
      : {
          issueNumber: row.parentIssueNumber,
          issueUrl: row.parentIssueUrl,
        },
  blockedBy,
})

export interface DbServiceShape {
  readonly repositoryChanges: Stream.Stream<void>
  readonly issueChanges: Stream.Stream<string>
  readonly workItemChanges: Stream.Stream<string>
  /**
   * Publish that a repository's issue set changed. Issue mutations
   * (`storeIssue`, `deleteIssue`, `markIssuesReconciled`) do **not** publish
   * automatically so batch reconciles can notify once; callers must invoke this
   * after a successful mutation batch when subscribers should refresh.
   */
  readonly notifyIssuesChanged: (repositoryId: string) => Effect.Effect<void>
  readonly notifyWorkItemsChanged: (repositoryId: string) => Effect.Effect<void>
  readonly getConfig: Effect.Effect<ConfigRecord, DatabaseError>
  readonly getBackendModelPrefs: (
    backendId: string,
  ) => Effect.Effect<BackendModelPrefs, DatabaseError>
  /**
   * Repository-scoped build/review prefs for one Agent Backend. Empty when
   * that backend has no stored override on the Repository.
   */
  readonly getRepositoryBackendModelPrefs: (
    repositoryId: string,
    backendId: string,
  ) => Effect.Effect<BackendModelPrefs, DatabaseError | RepositoryNotFoundError>
  readonly updateConfig: (
    input: UpdateConfigInput,
  ) => Effect.Effect<
    ConfigRecord,
    | InvalidConfigInputError
    | AgentBackendChangeBlockedError
    | GuaranteedMinAgentTurnsExceedsCapError
    | DatabaseError
  >
  /**
   * Fleet-wide unfinished Work Item total (not terminal complete/failed/
   * abandoned; includes Needs Human, paused, and Waiting for Worker Slot).
   * Visibility/UI only — backend-change gates use scoped blocking counts
   * (inheriting repos for harness default; one repository for override).
   */
  readonly countUnfinishedWorkItems: Effect.Effect<number, DatabaseError>
  /**
   * Unfinished ordinary Work Items on Repositories that inherit the harness
   * default (override is null). Explicit-profile Work Items are excluded.
   * Blocks changing Config.selectedAgentBackend when > 0.
   */
  readonly countBlockingUnfinishedForGlobalDefault: Effect.Effect<
    number,
    DatabaseError
  >
  /**
   * Unfinished ordinary Work Items on one Repository. Explicit-profile Work
   * Items are excluded. Blocks changing that Repository's Agent Backend
   * override when > 0.
   */
  readonly countBlockingUnfinishedForRepository: (
    repositoryId: string,
  ) => Effect.Effect<number, DatabaseError>
  /**
   * Selected-or-in-use Agent Backend ids: harness default ∪ distinct
   * Repository overrides ∪ unfinished Work Items' captured backends.
   * Used to hot-activate / drop Active backends after settings Save.
   */
  readonly listSelectedOrInUseBackendIds: Effect.Effect<
    ReadonlyArray<string>,
    DatabaseError
  >
  readonly addRepository: (
    input: AddRepositoryInput,
  ) => Effect.Effect<
    RepositoryRecord,
    | InvalidRepositoryInputError
    | RepositoryAlreadyExistsError
    | LocalPathInUseError
    | DatabaseError
  >
  readonly updateRepositorySettings: (
    input: UpdateRepositorySettingsInput,
  ) => Effect.Effect<
    RepositoryRecord,
    | InvalidRepositorySettingsError
    | AgentBackendChangeBlockedError
    | RepositoryIdentityChangeBlockedError
    | RepositoryAlreadyExistsError
    | RepositoryNotFoundError
    | GuaranteedMinAgentTurnsExceedsCapError
    | DatabaseError
  >
  readonly pauseRepository: (
    repositoryId: string,
  ) => Effect.Effect<RepositoryRecord, RepositoryNotFoundError | DatabaseError>
  readonly unpauseRepository: (
    repositoryId: string,
  ) => Effect.Effect<RepositoryRecord, RepositoryNotFoundError | DatabaseError>
  readonly listRepositories: Effect.Effect<
    readonly RepositoryRecord[],
    DatabaseError
  >
  readonly removeRepository: (
    repositoryId: string,
  ) => Effect.Effect<
    void,
    RepositoryNotFoundError | RepositoryHasRunningStepError | DatabaseError
  >
  /**
   * Upsert one issue. Does not publish `issueChanges`; call `notifyIssuesChanged`
   * after the mutation batch when UI/subscribers should refresh.
   */
  readonly storeIssue: (
    input: StoreIssueInput,
  ) => Effect.Effect<
    IssueRecord,
    InvalidIssueInputError | RepositoryNotFoundError | DatabaseError
  >
  readonly listIssues: (
    repositoryId: string,
  ) => Effect.Effect<
    readonly IssueRecord[],
    RepositoryNotFoundError | DatabaseError
  >
  readonly listWorkItemPullRequests: (
    repositoryId: string,
  ) => Effect.Effect<
    readonly WorkItemPullRequest[],
    RepositoryNotFoundError | DatabaseError
  >
  readonly listUnfinishedCreatePrWorkItems: (
    repositoryId: string,
  ) => Effect.Effect<
    readonly UnfinishedCreatePrWorkItem[],
    RepositoryNotFoundError | DatabaseError
  >
  /**
   * Delete one issue. Does not publish `issueChanges`; call `notifyIssuesChanged`
   * after the mutation batch when UI/subscribers should refresh.
   */
  readonly deleteIssue: (
    repositoryId: string,
    issueNumber: number,
  ) => Effect.Effect<void, RepositoryNotFoundError | DatabaseError>
  /**
   * Record reconciliation completion. Does not publish `issueChanges`; call
   * `notifyIssuesChanged` after the mutation batch when UI/subscribers should refresh.
   */
  readonly markIssuesReconciled: (
    repositoryId: string,
    reconciledAt: Date,
  ) => Effect.Effect<void, RepositoryNotFoundError | DatabaseError>
}

export class DbService extends Context.Service<DbService, DbServiceShape>()(
  "@ready-for-agent/db-service/DbService",
) {}

/**
 * Process-global PubSubs. Survive Effect Layer rebuilds and HMR so workers and
 * GraphQL subscriptions always share the same signal channel (in-layer PubSubs
 * leave zombie workers publishing to a bus nobody listens to). Kept intentionally
 * outside Layer lifecycle; do not replace with Layer-scoped PubSub without a
 * shared root layer that outlives both the job worker and GraphQL runtime.
 */
const repositoryChangesKey = Symbol.for(
  "@ready-for-agent/db-service/repository-changes",
)
const issueChangesKey = Symbol.for("@ready-for-agent/db-service/issue-changes")
const workItemChangesKey = Symbol.for(
  "@ready-for-agent/db-service/work-item-changes",
)

type InvalidationGlobal = typeof globalThis & {
  [repositoryChangesKey]?: PubSub.PubSub<void>
  [issueChangesKey]?: PubSub.PubSub<string>
  [workItemChangesKey]?: PubSub.PubSub<string>
}

const getRepositoryChanges = (): PubSub.PubSub<void> => {
  const globalState = globalThis as InvalidationGlobal
  globalState[repositoryChangesKey] ??= Effect.runSync(PubSub.unbounded<void>())
  return globalState[repositoryChangesKey]
}

const getIssueChanges = (): PubSub.PubSub<string> => {
  const globalState = globalThis as InvalidationGlobal
  globalState[issueChangesKey] ??= Effect.runSync(PubSub.unbounded<string>())
  return globalState[issueChangesKey]
}

const getWorkItemChanges = (): PubSub.PubSub<string> => {
  const globalState = globalThis as InvalidationGlobal
  globalState[workItemChangesKey] ??= Effect.runSync(PubSub.unbounded<string>())
  return globalState[workItemChangesKey]
}

const publishRepositoryChanged = (): Effect.Effect<void> =>
  PubSub.publish(getRepositoryChanges(), undefined).pipe(Effect.asVoid)

const publishIssuesChanged = (repositoryId: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* PubSub.publish(getIssueChanges(), repositoryId)
    yield* PubSub.publish(getRepositoryChanges(), undefined)
  }).pipe(Effect.asVoid)

const publishWorkItemsChanged = (repositoryId: string): Effect.Effect<void> =>
  PubSub.publish(getWorkItemChanges(), repositoryId).pipe(Effect.asVoid)

const repositoryChangesStream: Stream.Stream<void> = Stream.fromPubSub(
  getRepositoryChanges(),
)

const issueChangesStream: Stream.Stream<string> = Stream.fromPubSub(
  getIssueChanges(),
)

const workItemChangesStream: Stream.Stream<string> = Stream.fromPubSub(
  getWorkItemChanges(),
)

export const DbServiceLive = Layer.effect(
  DbService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const configSelect = `selected_agent_backend, default_model, default_thinking_level,
                    review_model, review_thinking_level, backend_model_prefs,
                    max_concurrent_agent_turns, max_concurrent_work_items`

    const toConfigRecord = (row: {
      readonly selectedAgentBackend: string
      readonly defaultModel: string | null
      readonly defaultThinkingLevel: string | null
      readonly reviewModel: string | null
      readonly reviewThinkingLevel: string | null
      readonly maxConcurrentAgentTurns: number
      readonly maxConcurrentWorkItems: number
    }): ConfigRecord =>
      ConfigRecord.make({
        selectedAgentBackend: row.selectedAgentBackend,
        defaultModel: row.defaultModel,
        defaultThinkingLevel: row.defaultThinkingLevel,
        reviewModel: row.reviewModel,
        reviewThinkingLevel: row.reviewThinkingLevel,
        maxConcurrentAgentTurns: row.maxConcurrentAgentTurns,
        maxConcurrentWorkItems: row.maxConcurrentWorkItems,
      })

    const readCount = (rows: readonly { readonly count: number }[]): number => {
      const count = rows[0]?.count
      return typeof count === "number" && Number.isFinite(count) ? count : 0
    }

    /** Fleet-wide unfinished total (visibility; not the global backend gate). */
    const countUnfinishedWorkItems: Effect.Effect<number, DatabaseError> =
      Effect.gen(function* () {
        const rows = (yield* sql
          .unsafe(
            `SELECT COUNT(*) AS count FROM work_item
             WHERE ${isUnfinishedStateSql()}`,
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly {
          readonly count: number
        }[]
        return readCount(rows)
      }).pipe(Effect.withSpan("DbService.countUnfinishedWorkItems"))

    /**
     * Unfinished ordinary Work Items on Repositories that inherit the harness
     * default (override is null). Explicit-profile Work Items do not block.
     */
    const countBlockingUnfinishedForGlobalDefault: Effect.Effect<
      number,
      DatabaseError
    > = Effect.gen(function* () {
      const rows = (yield* sql
        .unsafe(
          `SELECT COUNT(*) AS count
             FROM work_item wi
             INNER JOIN repository r ON r.id = wi.repository_id
             WHERE ${isSettingsResolvedUnfinishedSql("wi")}
               AND r.selected_agent_backend IS NULL`,
        )
        .pipe(Effect.mapError(toDatabaseError))) as readonly {
        readonly count: number
      }[]
      return readCount(rows)
    }).pipe(
      Effect.withSpan("DbService.countBlockingUnfinishedForGlobalDefault"),
    )

    /**
     * Unfinished ordinary Work Items on one Repository (blocks that repo's
     * override change). Explicit-profile Work Items do not block.
     */
    const countBlockingUnfinishedForRepository = (
      repositoryId: string,
    ): Effect.Effect<number, DatabaseError> =>
      Effect.gen(function* () {
        const rows = (yield* sql
          .unsafe(
            `SELECT COUNT(*) AS count FROM work_item
             WHERE repository_id = ?
               AND ${isSettingsResolvedUnfinishedSql()}`,
            [repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly {
          readonly count: number
        }[]
        return readCount(rows)
      }).pipe(Effect.withSpan("DbService.countBlockingUnfinishedForRepository"))

    const readConfigRow = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* sql
        .unsafe(
          `INSERT OR IGNORE INTO config (
               id, selected_agent_backend, default_model, default_thinking_level,
               review_model, review_thinking_level, backend_model_prefs,
               max_concurrent_agent_turns, max_concurrent_work_items,
               created_at, updated_at
             ) VALUES ('default', 'opencode', NULL, NULL, NULL, NULL, '{}', 2, 5, ?, ?)`,
          [now, now],
        )
        .pipe(Effect.mapError(toDatabaseError))

      const rows = yield* sql
        .unsafe(
          `SELECT ${configSelect}
             FROM config WHERE id = 'default'`,
        )
        .pipe(Effect.mapError(toDatabaseError))
      const decoded = yield* decodeConfigRows(rows)
      const row = decoded[0]
      if (!row) {
        return yield* new DatabaseError({
          message: "No config returned after initialization",
        })
      }
      return row
    })

    const getConfig: Effect.Effect<ConfigRecord, DatabaseError> = Effect.gen(
      function* () {
        return toConfigRecord(yield* readConfigRow)
      },
    ).pipe(Effect.withSpan("DbService.getConfig"))

    /**
     * Selected-or-in-use set for Active multi-backend registry sync after Save.
     */
    const listSelectedOrInUseBackendIds: Effect.Effect<
      ReadonlyArray<string>,
      DatabaseError
    > = Effect.gen(function* () {
      const config = yield* getConfig
      const ids = new Set<string>()
      const harnessDefault = config.selectedAgentBackend.trim()
      if (
        harnessDefault.length > 0 &&
        isSelectableAgentBackendId(harnessDefault)
      ) {
        ids.add(harnessDefault)
      }
      const overrideRows = (yield* sql
        .unsafe(
          `SELECT DISTINCT selected_agent_backend AS selectedAgentBackend
           FROM repository
           WHERE selected_agent_backend IS NOT NULL
             AND trim(selected_agent_backend) != ''`,
        )
        .pipe(Effect.mapError(toDatabaseError))) as readonly {
        readonly selectedAgentBackend: string | null
      }[]
      for (const row of overrideRows) {
        const id = row.selectedAgentBackend?.trim()
        if (
          id !== undefined &&
          id.length > 0 &&
          isSelectableAgentBackendId(id)
        ) {
          ids.add(id)
        }
      }
      const captureRows = (yield* sql
        .unsafe(
          `SELECT DISTINCT agent_backend AS agentBackend
           FROM work_item
           WHERE ${isUnfinishedStateSql()}
             AND agent_backend IS NOT NULL
             AND trim(agent_backend) != ''`,
        )
        .pipe(Effect.mapError(toDatabaseError))) as readonly {
        readonly agentBackend: string | null
      }[]
      for (const row of captureRows) {
        const id = row.agentBackend?.trim()
        if (
          id !== undefined &&
          id.length > 0 &&
          isSelectableAgentBackendId(id)
        ) {
          ids.add(id)
        }
      }
      if (ids.size === 0) {
        return ["opencode"]
      }
      // Stable order: harness default first (operational input for Active seed /
      // setSelectedOrInUse proxy fallback), then remaining selectable ids sorted.
      const primary =
        harnessDefault.length > 0 &&
        isSelectableAgentBackendId(harnessDefault) &&
        ids.has(harnessDefault)
          ? harnessDefault
          : null
      const remaining = [...ids].filter((id) => id !== primary).sort()
      return primary === null ? remaining : [primary, ...remaining]
    }).pipe(Effect.withSpan("DbService.listSelectedOrInUseBackendIds"))

    const getBackendModelPrefs = Effect.fn("DbService.getBackendModelPrefs")(
      function* (backendId: string) {
        const row = yield* readConfigRow
        const map = parseBackendModelPrefsMap(row.backendModelPrefs)
        return prefsForBackend(map, backendId.trim())
      },
    )

    const getRepositoryBackendModelPrefs = Effect.fn(
      "DbService.getRepositoryBackendModelPrefs",
    )(function* (repositoryId: string, backendId: string) {
      const rows = (yield* sql
        .unsafe(
          `SELECT backend_model_prefs AS backendModelPrefs
           FROM repository WHERE id = ?`,
          [repositoryId],
        )
        .pipe(Effect.mapError(toDatabaseError))) as readonly {
        readonly backendModelPrefs: string
      }[]
      const row = rows[0]
      if (row === undefined) {
        return yield* new RepositoryNotFoundError({ repositoryId })
      }
      return prefsForBackend(
        parseBackendModelPrefsMap(row.backendModelPrefs ?? "{}"),
        backendId.trim(),
      )
    })

    /**
     * Re-project flat model columns from backendModelPrefs for repositories
     * that inherit the harness default (selected_agent_backend IS NULL). Explicit
     * overrides keep their own effective backend projection.
     */
    const projectInheritingRepositoryFlatColumns = (
      now: number,
      harnessDefaultBackendId: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const rows = (yield* sql.unsafe(
          `SELECT id, backend_model_prefs AS backendModelPrefs FROM repository
           WHERE selected_agent_backend IS NULL`,
        )) as readonly {
          readonly id: string
          readonly backendModelPrefs: string
        }[]
        for (const row of rows) {
          const prefs = prefsForBackend(
            parseBackendModelPrefsMap(row.backendModelPrefs ?? "{}"),
            harnessDefaultBackendId,
          )
          yield* sql.unsafe(
            `UPDATE repository SET
               default_model = ?,
               default_thinking_level = ?,
               review_model = ?,
               review_thinking_level = ?,
               updated_at = ?
             WHERE id = ?`,
            [
              prefs.defaultModel,
              prefs.defaultThinkingLevel,
              prefs.reviewModel,
              prefs.reviewThinkingLevel,
              now,
              row.id,
            ],
          )
        }
      })

    const updateConfig = Effect.fn("DbService.updateConfig")(function* (
      input: UpdateConfigInput,
    ) {
      const selectedAgentBackend = input.selectedAgentBackend.trim()
      if (selectedAgentBackend.length === 0) {
        return yield* new InvalidConfigInputError({
          field: "selectedAgentBackend",
          message: "selectedAgentBackend cannot be empty",
        })
      }
      if (!isSelectableAgentBackendId(selectedAgentBackend)) {
        return yield* new InvalidConfigInputError({
          field: "selectedAgentBackend",
          message: `Unknown Agent Backend: ${selectedAgentBackend}`,
        })
      }

      if (
        !Number.isSafeInteger(input.maxConcurrentAgentTurns) ||
        input.maxConcurrentAgentTurns < 1
      ) {
        return yield* new InvalidConfigInputError({
          field: "maxConcurrentAgentTurns",
          message: "maxConcurrentAgentTurns must be a positive integer",
        })
      }
      const maxConcurrentAgentTurns = input.maxConcurrentAgentTurns
      if (
        !Number.isSafeInteger(input.maxConcurrentWorkItems) ||
        input.maxConcurrentWorkItems < 1
      ) {
        return yield* new InvalidConfigInputError({
          field: "maxConcurrentWorkItems",
          message: "maxConcurrentWorkItems must be a positive integer",
        })
      }
      const maxConcurrentWorkItems = input.maxConcurrentWorkItems

      // Ensure config row exists (fresh DBs) before the write transaction.
      yield* readConfigRow

      // Normalize model fields once. Null/whitespace-only means "inherit
      // backend default" and is a valid resting state on every update,
      // whether or not selectedAgentBackend is also changing (issue #33).
      const defaultModel = yield* normalizeOptionalConfigSetting(
        input.defaultModel,
      )
      const defaultThinkingLevel = yield* normalizeOptionalConfigSetting(
        input.defaultThinkingLevel,
      )
      const reviewModel = yield* normalizeOptionalConfigSetting(
        input.reviewModel,
      )
      const reviewThinkingLevel = yield* normalizeOptionalConfigSetting(
        input.reviewThinkingLevel,
      )

      const now = yield* Clock.currentTimeMillis
      const { rows, repositoryProjectionChanged } = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Re-read config + unfinished count inside the transaction so a
            // concurrent Implement Now cannot race past the idle gate.
            // Production SqlClient uses BEGIN IMMEDIATE (write lock at start).
            const latestRows = yield* sql
              .unsafe(`SELECT ${configSelect} FROM config WHERE id = 'default'`)
              .pipe(Effect.mapError(toDatabaseError))
            const latestDecoded = yield* decodeConfigRows(latestRows)
            const latest = latestDecoded[0]
            if (!latest) {
              return yield* new DatabaseError({
                message: "No config returned during update",
              })
            }
            const changing =
              selectedAgentBackend !== latest.selectedAgentBackend
            if (changing) {
              // Gate on ordinary inheriting WIP only. Explicit-override WIP
              // and explicit-profile Work Items do not block this change.
              const count = yield* countBlockingUnfinishedForGlobalDefault
              if (count > 0) {
                return yield* new AgentBackendChangeBlockedError({
                  message: `Cannot change default Agent Backend while ${count} Work Item(s) are unfinished on Repositories that inherit the default`,
                  unfinishedWorkItemCount: count,
                  scope: "global",
                })
              }
              yield* projectInheritingRepositoryFlatColumns(
                now,
                selectedAgentBackend,
              ).pipe(Effect.mapError(toDatabaseError))
            }
            if (maxConcurrentAgentTurns < latest.maxConcurrentAgentTurns) {
              // Only lowering the cap can newly oversubscribe guarantees.
              const guaranteedSumRows = (yield* sql
                .unsafe(
                  `SELECT COALESCE(SUM(guaranteed_min_concurrent_agent_turns), 0) AS sum
                   FROM repository
                   WHERE guaranteed_min_concurrent_agent_turns IS NOT NULL`,
                )
                .pipe(Effect.mapError(toDatabaseError))) as readonly {
                readonly sum: number
              }[]
              const guaranteedSum = guaranteedSumRows[0]?.sum ?? 0
              if (guaranteedSum > maxConcurrentAgentTurns) {
                return yield* new GuaranteedMinAgentTurnsExceedsCapError({
                  message: `Cannot lower maxConcurrentAgentTurns to ${maxConcurrentAgentTurns}: the sum of all Repositories' guaranteed-minimum Agent Turns (${guaranteedSum}) would exceed it`,
                  maxConcurrentAgentTurns,
                  sumOfGuaranteedMinConcurrentAgentTurns: guaranteedSum,
                })
              }
            }
            // Same-backend updates may set defaultModel to null: that is the
            // valid "inherit backend default" resting state also returned by
            // getConfig, so the write side must accept what the read side
            // can return (issue #33).
            // Merge prefs from the in-txn row so concurrent writers do not
            // clobber each other's per-backend map entries.
            const prefsMap = parseBackendModelPrefsMap(latest.backendModelPrefs)
            prefsMap[selectedAgentBackend] = {
              defaultModel,
              defaultThinkingLevel,
              reviewModel,
              reviewThinkingLevel,
            }
            const backendModelPrefs = serializeBackendModelPrefsMap(prefsMap)
            const written = yield* sql
              .unsafe(
                `INSERT INTO config (
                   id, selected_agent_backend, default_model, default_thinking_level,
                   review_model, review_thinking_level, backend_model_prefs,
                   max_concurrent_agent_turns, max_concurrent_work_items,
                   agent_backend_configured_at, created_at, updated_at
                 ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET
                   selected_agent_backend = excluded.selected_agent_backend,
                   default_model = excluded.default_model,
                   default_thinking_level = excluded.default_thinking_level,
                   review_model = excluded.review_model,
                   review_thinking_level = excluded.review_thinking_level,
                   backend_model_prefs = excluded.backend_model_prefs,
                   max_concurrent_agent_turns = excluded.max_concurrent_agent_turns,
                   max_concurrent_work_items = excluded.max_concurrent_work_items,
                   agent_backend_configured_at = excluded.agent_backend_configured_at,
                   updated_at = excluded.updated_at
                 RETURNING ${configSelect}`,
                [
                  selectedAgentBackend,
                  defaultModel,
                  defaultThinkingLevel,
                  reviewModel,
                  reviewThinkingLevel,
                  backendModelPrefs,
                  maxConcurrentAgentTurns,
                  maxConcurrentWorkItems,
                  now,
                  now,
                  now,
                ],
              )
              .pipe(Effect.mapError(toDatabaseError))
            // Publish from in-txn changing (not a pre-txn snapshot) so concurrent
            // reverse-switches still notify clients after repo flat re-projection.
            return {
              rows: written,
              repositoryProjectionChanged: changing,
            }
          }),
        )
        .pipe(
          Effect.mapError((error: unknown) => {
            if (
              typeof error === "object" &&
              error !== null &&
              "_tag" in error
            ) {
              const tag = (error as { _tag: string })._tag
              if (
                tag === "AgentBackendChangeBlockedError" ||
                tag === "DatabaseError" ||
                tag === "InvalidConfigInputError" ||
                tag === "GuaranteedMinAgentTurnsExceedsCapError"
              ) {
                return error as
                  | AgentBackendChangeBlockedError
                  | DatabaseError
                  | InvalidConfigInputError
                  | GuaranteedMinAgentTurnsExceedsCapError
              }
            }
            return toDatabaseError(error as SqlError)
          }),
        )
      const decoded = yield* decodeConfigRows(rows)
      const row = decoded[0]
      if (!row) {
        return yield* new DatabaseError({
          message: "No config returned from update",
        })
      }
      if (repositoryProjectionChanged) {
        yield* publishRepositoryChanged()
      }
      return toConfigRecord(row)
    })

    const addRepository = Effect.fn("DbService.addRepository")(function* (
      input: AddRepositoryInput,
    ) {
      const forgeHost = (yield* trimRequired(
        input.forgeHost,
        "forgeHost",
      )).toLowerCase()
      const projectPath = yield* trimRequired(input.projectPath, "projectPath")
      const localPath = yield* trimRequired(input.localPath, "localPath")
      const now = yield* Clock.currentTimeMillis
      const id = RepositoryId.make(`repo-${ulid()}`)

      const existingByForgeIdentity = yield* sql
        .unsafe(
          `SELECT id FROM repository
             WHERE forge = ? AND forge_host = ? AND lower(project_path) = ?
             LIMIT 1`,
          [input.forge, forgeHost, projectPath.toLowerCase()],
        )
        .pipe(Effect.mapError(toDatabaseError))

      if (existingByForgeIdentity[0]) {
        return yield* new RepositoryAlreadyExistsError({
          forge: input.forge,
          forgeHost,
          projectPath,
        })
      }

      const existingByPath = yield* sql`
        SELECT id FROM repository WHERE local_path = ${localPath} LIMIT 1
      `.pipe(Effect.mapError(toDatabaseError))

      if (existingByPath[0]) {
        return yield* new LocalPathInUseError({ localPath })
      }

      const result = yield* sql
        .unsafe(
          `INSERT INTO repository (
               id, forge, forge_host, project_path, local_path, is_bare, paused,
               selected_agent_backend,
               default_model, default_thinking_level, review_model, review_thinking_level,
               backend_model_prefs,
               merge_policy, include_all_issue_authors, wait_for_ready_for_review_checks,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, '{}', ?, ?, ?, ?, ?)
             RETURNING ${repositorySelectColumns}`,
          [
            id,
            input.forge,
            forgeHost,
            projectPath,
            localPath,
            input.isBare,
            true,
            "off",
            false,
            true,
            now,
            now,
          ],
        )
        .pipe(
          Effect.mapError((error: SqlError) => {
            if (isUniqueConstraint(error)) {
              const message = formatSqlError(error).toLowerCase()
              if (
                message.includes("local_path") ||
                message.includes("localpath")
              ) {
                return new LocalPathInUseError({ localPath })
              }
              return new RepositoryAlreadyExistsError({
                forge: input.forge,
                forgeHost,
                projectPath,
              })
            }
            return toDatabaseError(error)
          }),
        )

      const decoded = yield* decodeRepositoryRows(result)
      const row = decoded[0]
      if (!row) {
        return yield* new DatabaseError({
          message: "No repository returned from insert",
        })
      }

      const repository = toRepositoryRecord(row)
      yield* publishRepositoryChanged()
      return repository
    })

    const updateRepositorySettings = Effect.fn(
      "DbService.updateRepositorySettings",
    )(function* (input: UpdateRepositorySettingsInput) {
      const requestedForgeHost =
        input.forgeHost === undefined
          ? undefined
          : yield* normalizeRequiredRepositorySetting(
              input.forgeHost,
              "forgeHost",
            )
      const requestedProjectPath =
        input.projectPath === undefined
          ? undefined
          : yield* normalizeRequiredRepositorySetting(
              input.projectPath,
              "projectPath",
            )
      const defaultModel = yield* normalizeOptionalSetting(input.defaultModel)
      const defaultThinkingLevel = yield* normalizeOptionalSetting(
        input.defaultThinkingLevel,
      )
      const reviewModel = yield* normalizeOptionalSetting(input.reviewModel)
      const reviewThinkingLevel = yield* normalizeOptionalSetting(
        input.reviewThinkingLevel,
      )
      // undefined = leave override unchanged; null/string = set/clear after validate.
      const requestedOverride =
        input.selectedAgentBackend === undefined
          ? undefined
          : yield* normalizeRepositoryAgentBackendOverride(
              input.selectedAgentBackend,
            )
      // undefined = leave guarantee unchanged; null/number = clear/set after validate.
      const requestedGuaranteedMin =
        input.guaranteedMinConcurrentAgentTurns === undefined
          ? undefined
          : yield* normalizeGuaranteedMinAgentTurns(
              input.guaranteedMinConcurrentAgentTurns,
            )
      const now = yield* Clock.currentTimeMillis
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Re-read harness default and repo row inside the txn so concurrent
            // config switches cannot mis-key prefs / flat columns.
            const configRows = yield* sql
              .unsafe(
                `SELECT selected_agent_backend AS selectedAgentBackend,
                        max_concurrent_agent_turns AS maxConcurrentAgentTurns
                 FROM config WHERE id = 'default'`,
              )
              .pipe(Effect.mapError(toDatabaseError))
            const configRow = configRows[0] as
              | {
                  readonly selectedAgentBackend: string
                  readonly maxConcurrentAgentTurns: number
                }
              | undefined
            const harnessDefault = configRow?.selectedAgentBackend ?? "opencode"
            const maxConcurrentAgentTurns =
              configRow?.maxConcurrentAgentTurns ?? 2
            const existingRows = yield* sql
              .unsafe(
                `SELECT forge,
                        forge_host AS forgeHost,
                        project_path AS projectPath,
                        selected_agent_backend AS selectedAgentBackend,
                        backend_model_prefs AS backendModelPrefs,
                        guaranteed_min_concurrent_agent_turns AS guaranteedMinConcurrentAgentTurns
                 FROM repository WHERE id = ?`,
                [input.repositoryId],
              )
              .pipe(Effect.mapError(toDatabaseError))
            const existing = existingRows[0] as
              | {
                  readonly selectedAgentBackend: string | null
                  readonly backendModelPrefs: string
                  readonly forge: RepositoryRecord["forge"]
                  readonly forgeHost: string
                  readonly projectPath: string
                  readonly guaranteedMinConcurrentAgentTurns: number | null
                }
              | undefined
            if (!existing) {
              return yield* new RepositoryNotFoundError({
                repositoryId: input.repositoryId,
              })
            }
            const nextForge = input.forge ?? existing.forge
            const nextForgeHost = requestedForgeHost ?? existing.forgeHost
            const nextProjectPath = requestedProjectPath ?? existing.projectPath
            const identityChanging =
              nextForge !== existing.forge ||
              nextForgeHost !== existing.forgeHost ||
              nextProjectPath.toLowerCase() !==
                existing.projectPath.toLowerCase()
            if (identityChanging) {
              const workItemRows = (yield* sql
                .unsafe(
                  `SELECT COUNT(*) AS count FROM work_item
                   WHERE repository_id = ?`,
                  [input.repositoryId],
                )
                .pipe(Effect.mapError(toDatabaseError))) as readonly {
                readonly count: number
              }[]
              const workItemCount = readCount(workItemRows)
              if (workItemCount > 0) {
                return yield* new RepositoryIdentityChangeBlockedError({
                  repositoryId: input.repositoryId,
                  workItemCount,
                  message: `Cannot change Repository Forge identity while ${workItemCount} Work Item(s) exist on this Repository`,
                })
              }
              const duplicateRows = (yield* sql
                .unsafe(
                  `SELECT id FROM repository
                   WHERE forge = ?
                     AND forge_host = ?
                     AND lower(project_path) = lower(?)
                     AND id <> ?
                   LIMIT 1`,
                  [
                    nextForge,
                    nextForgeHost,
                    nextProjectPath,
                    input.repositoryId,
                  ],
                )
                .pipe(Effect.mapError(toDatabaseError))) as readonly {
                readonly id: string
              }[]
              if (duplicateRows.length > 0) {
                return yield* new RepositoryAlreadyExistsError({
                  forge: nextForge,
                  forgeHost: nextForgeHost,
                  projectPath: nextProjectPath,
                })
              }
            }
            const previousOverride = existing.selectedAgentBackend ?? null
            const nextOverride =
              requestedOverride === undefined
                ? previousOverride
                : requestedOverride
            const overrideChanging = nextOverride !== previousOverride
            if (overrideChanging) {
              const count = yield* countBlockingUnfinishedForRepository(
                input.repositoryId,
              )
              if (count > 0) {
                return yield* new AgentBackendChangeBlockedError({
                  message: `Cannot change Repository Agent Backend while ${count} Work Item(s) are unfinished on this Repository`,
                  unfinishedWorkItemCount: count,
                  scope: "repository",
                  repositoryId: input.repositoryId,
                })
              }
            }
            const previousGuaranteedMin =
              existing.guaranteedMinConcurrentAgentTurns ?? null
            const nextGuaranteedMin =
              requestedGuaranteedMin === undefined
                ? previousGuaranteedMin
                : requestedGuaranteedMin
            const guaranteedMinRaised =
              (nextGuaranteedMin ?? 0) > (previousGuaranteedMin ?? 0)
            if (guaranteedMinRaised) {
              const otherRepoSumRows = (yield* sql
                .unsafe(
                  `SELECT COALESCE(SUM(guaranteed_min_concurrent_agent_turns), 0) AS sum
                   FROM repository
                   WHERE id <> ?
                     AND guaranteed_min_concurrent_agent_turns IS NOT NULL`,
                  [input.repositoryId],
                )
                .pipe(Effect.mapError(toDatabaseError))) as readonly {
                readonly sum: number
              }[]
              const otherRepoSum = otherRepoSumRows[0]?.sum ?? 0
              const totalGuaranteed = otherRepoSum + (nextGuaranteedMin ?? 0)
              if (totalGuaranteed > maxConcurrentAgentTurns) {
                return yield* new GuaranteedMinAgentTurnsExceedsCapError({
                  message: `Cannot set guaranteed-minimum Agent Turns to ${nextGuaranteedMin}: the sum of all Repositories' guarantees (${totalGuaranteed}) would exceed maxConcurrentAgentTurns (${maxConcurrentAgentTurns})`,
                  maxConcurrentAgentTurns,
                  sumOfGuaranteedMinConcurrentAgentTurns: totalGuaranteed,
                })
              }
            }
            const effectiveBackend = effectiveAgentBackend(
              nextOverride,
              harnessDefault,
            )
            const prefsMap = parseBackendModelPrefsMap(
              existing.backendModelPrefs ?? "{}",
            )
            // Model settings write to the effective backend's map entry.
            prefsMap[effectiveBackend] = {
              defaultModel,
              defaultThinkingLevel,
              reviewModel,
              reviewThinkingLevel,
            }
            // When only the override changes, flat columns should still reflect
            // the (possibly empty) prefs for the new effective backend — which
            // we just wrote from this request's model fields.
            const backendModelPrefs = serializeBackendModelPrefsMap(prefsMap)
            return yield* sql
              .unsafe(
                `UPDATE repository
             SET forge = ?,
                 forge_host = ?,
                 project_path = ?,
                 paused = ?,
                 selected_agent_backend = ?,
                 default_model = ?,
                 default_thinking_level = ?,
                 review_model = ?,
                 review_thinking_level = ?,
                 backend_model_prefs = ?,
                 merge_policy = ?,
                 guaranteed_min_concurrent_agent_turns = ?,
                 include_all_issue_authors = ?,
                 wait_for_ready_for_review_checks = ?,
                 updated_at = ?
             WHERE id = ?
             RETURNING ${repositorySelectColumns}`,
                [
                  nextForge,
                  nextForgeHost,
                  nextProjectPath,
                  input.paused,
                  nextOverride,
                  defaultModel,
                  defaultThinkingLevel,
                  reviewModel,
                  reviewThinkingLevel,
                  backendModelPrefs,
                  input.mergePolicy,
                  nextGuaranteedMin,
                  input.includeAllIssueAuthors,
                  input.waitForReadyForReviewChecks,
                  now,
                  input.repositoryId,
                ],
              )
              .pipe(Effect.mapError(toDatabaseError))
          }),
        )
        .pipe(
          Effect.mapError((error: unknown) => {
            if (
              typeof error === "object" &&
              error !== null &&
              "_tag" in error
            ) {
              const tag = (error as { _tag: string })._tag
              if (
                tag === "RepositoryNotFoundError" ||
                tag === "DatabaseError" ||
                tag === "AgentBackendChangeBlockedError" ||
                tag === "RepositoryIdentityChangeBlockedError" ||
                tag === "RepositoryAlreadyExistsError" ||
                tag === "InvalidRepositorySettingsError" ||
                tag === "GuaranteedMinAgentTurnsExceedsCapError"
              ) {
                return error as
                  | RepositoryNotFoundError
                  | DatabaseError
                  | AgentBackendChangeBlockedError
                  | RepositoryIdentityChangeBlockedError
                  | RepositoryAlreadyExistsError
                  | InvalidRepositorySettingsError
                  | GuaranteedMinAgentTurnsExceedsCapError
              }
            }
            if (isUniqueConstraint(error as SqlError)) {
              return new RepositoryAlreadyExistsError({
                forge: input.forge ?? "github",
                forgeHost: requestedForgeHost ?? "",
                projectPath: requestedProjectPath ?? "",
              })
            }
            return toDatabaseError(error as SqlError)
          }),
        )

      const decoded = yield* decodeRepositoryRows(result)
      const row = decoded[0]
      if (!row) {
        return yield* new RepositoryNotFoundError({
          repositoryId: input.repositoryId,
        })
      }

      const repository = toRepositoryRecord(row)
      yield* publishRepositoryChanged()
      return repository
    })

    const setRepositoryPaused = Effect.fn("DbService.setRepositoryPaused")(
      function* (repositoryId: string, paused: boolean) {
        const now = yield* Clock.currentTimeMillis
        const result = yield* sql
          .unsafe(
            `UPDATE repository
             SET paused = ?,
                 updated_at = ?
             WHERE id = ?
             RETURNING ${repositorySelectColumns}`,
            [paused, now, repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))

        const decoded = yield* decodeRepositoryRows(result)
        const row = decoded[0]
        if (!row) {
          return yield* new RepositoryNotFoundError({ repositoryId })
        }

        const repository = toRepositoryRecord(row)
        yield* publishRepositoryChanged()
        return repository
      },
    )

    const pauseRepository = Effect.fn("DbService.pauseRepository")(function* (
      repositoryId: string,
    ) {
      return yield* setRepositoryPaused(repositoryId, true)
    })

    const unpauseRepository = Effect.fn("DbService.unpauseRepository")(
      function* (repositoryId: string) {
        return yield* setRepositoryPaused(repositoryId, false)
      },
    )

    const listRepositories: Effect.Effect<
      readonly RepositoryRecord[],
      DatabaseError
    > = Effect.gen(function* () {
      const repositories = yield* sql
        .unsafe(
          `SELECT ${repositorySelectColumns}
           FROM repository
           ORDER BY forge ASC, forge_host ASC, lower(project_path) ASC`,
        )
        .pipe(Effect.mapError(toDatabaseError))

      const decoded = yield* decodeRepositoryRows(repositories)
      return decoded.map((row) => toRepositoryRecord(row))
    }).pipe(Effect.withSpan("DbService.listRepositories"))

    const ensureRepositoryExists = Effect.fn(
      "DbService.ensureRepositoryExists",
    )(function* (repositoryId: string) {
      const repository = yield* sql`
          SELECT id FROM repository WHERE id = ${repositoryId} LIMIT 1
        `.pipe(Effect.mapError(toDatabaseError))

      if (!repository[0]) {
        return yield* new RepositoryNotFoundError({ repositoryId })
      }
    })

    const removeRepository = Effect.fn("DbService.removeRepository")(function* (
      repositoryId: string,
    ) {
      const now = yield* Clock.currentTimeMillis
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const runningRows = yield* sql
              .unsafe(
                `SELECT step_run.id AS step_run_id, step_run.work_item_id AS work_item_id
                 FROM step_run
                 INNER JOIN work_item ON work_item.id = step_run.work_item_id
                 WHERE work_item.repository_id = ?
                   AND step_run.status = 'running'
                 ORDER BY step_run.queued_at ASC, step_run.id ASC
                 LIMIT 1`,
                [repositoryId],
              )
              .pipe(Effect.mapError(toDatabaseError))
            const running = yield* decodeRunningStepRows(runningRows)

            if (running[0]) {
              return yield* new RepositoryHasRunningStepError({
                repositoryId,
                stepRunId: running[0].stepRunId,
                workItemId: running[0].workItemId,
              })
            }

            yield* sql.unsafe(
              `UPDATE step_run
                 SET status = 'cancelled',
                     finished_at = ?,
                     reason_code = 'repository_removed',
                     reason_message = 'Repository was removed before the Step Run started',
                     updated_at = ?
                 WHERE status = 'queued'
                   AND work_item_id IN (
                     SELECT id FROM work_item WHERE repository_id = ?
                   )`,
              [now, now, repositoryId],
            )

            yield* sql.unsafe(
              `DELETE FROM job_queue
                 WHERE id IN (
                   SELECT step_run.queue_job_id
                   FROM step_run
                   INNER JOIN work_item ON work_item.id = step_run.work_item_id
                   WHERE work_item.repository_id = ?
                     AND step_run.queue_job_id IS NOT NULL
                 )`,
              [repositoryId],
            )

            yield* sql.unsafe(
              `UPDATE work_item
                 SET state = 'abandoned',
                     state_ready_at = ?,
                     updated_at = ?
                 WHERE repository_id = ?
                   AND state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')`,
              [now, now, repositoryId],
            )

            yield* sql.unsafe(
              `DELETE FROM step_run
                 WHERE work_item_id IN (
                   SELECT id FROM work_item WHERE repository_id = ?
                 )`,
              [repositoryId],
            )

            yield* sql`DELETE FROM work_item WHERE repository_id = ${repositoryId}`

            yield* sql.unsafe(
              `DELETE FROM issue_dependency
               WHERE issue_id IN (
                 SELECT id FROM issue WHERE repository_id = ?
               )`,
              [repositoryId],
            )
            yield* sql`DELETE FROM issue WHERE repository_id = ${repositoryId}`
            const result = yield* sql`
              DELETE FROM repository WHERE id = ${repositoryId} RETURNING id
            `

            if (!result[0]) {
              return yield* new RepositoryNotFoundError({ repositoryId })
            }
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof RepositoryNotFoundError ||
            error instanceof RepositoryHasRunningStepError ||
            error instanceof DatabaseError
              ? error
              : toDatabaseError(error),
          ),
        )
      yield* publishRepositoryChanged()
      yield* publishWorkItemsChanged(repositoryId)
    })

    const storeIssue = Effect.fn("DbService.storeIssue")(function* (
      input: StoreIssueInput,
    ) {
      if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
        return yield* new InvalidIssueInputError({
          field: "issueNumber",
          message: "issueNumber must be a positive integer",
        })
      }
      if (input.title.trim().length === 0) {
        return yield* new InvalidIssueInputError({
          field: "title",
          message: "title cannot be empty",
        })
      }
      if (input.url.trim().length === 0) {
        return yield* new InvalidIssueInputError({
          field: "url",
          message: "url cannot be empty",
        })
      }
      if (input.state !== "OPEN" && input.state !== "CLOSED") {
        return yield* new InvalidIssueInputError({
          field: "state",
          message: "state must be OPEN or CLOSED",
        })
      }
      if (Number.isNaN(input.githubCreatedAt.getTime())) {
        return yield* new InvalidIssueInputError({
          field: "githubCreatedAt",
          message: "githubCreatedAt must be a valid date",
        })
      }

      if (
        input.parent !== null &&
        (!Number.isSafeInteger(input.parent.issueNumber) ||
          input.parent.issueNumber <= 0 ||
          !URL.canParse(input.parent.issueUrl))
      ) {
        return yield* new InvalidIssueInputError({
          field: "parent",
          message: "parent must have a positive issue number and valid URL",
        })
      }
      if (
        input.parentPosition !== null &&
        (!Number.isSafeInteger(input.parentPosition) ||
          input.parentPosition < 0)
      ) {
        return yield* new InvalidIssueInputError({
          field: "parentPosition",
          message: "parentPosition must be a non-negative integer or null",
        })
      }

      for (const dependency of input.blockedBy) {
        if (
          !Number.isSafeInteger(dependency.issueNumber) ||
          dependency.issueNumber <= 0
        ) {
          return yield* new InvalidIssueInputError({
            field: "blockedBy",
            message: "blockedBy issue numbers must be positive integers",
          })
        }
        if (!URL.canParse(dependency.issueUrl)) {
          return yield* new InvalidIssueInputError({
            field: "blockedBy",
            message: "blockedBy issue URLs must be valid URLs",
          })
        }
      }

      yield* ensureRepositoryExists(input.repositoryId)

      const now = yield* Clock.currentTimeMillis
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const issueAuthor =
              input.issueAuthor === null
                ? null
                : input.issueAuthor.trim() || null

            const result = yield* sql
              .unsafe(
                `INSERT INTO issue (
               id, repository_id, issue_number, title, body, url, state,
                github_created_at, issue_author, parent_issue_number,
                 parent_issue_url, parent_position, has_children,
                 created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repository_id, issue_number) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               url = excluded.url,
                state = excluded.state,
                github_created_at = excluded.github_created_at,
                 issue_author = excluded.issue_author,
                 parent_issue_number = excluded.parent_issue_number,
                 parent_issue_url = excluded.parent_issue_url,
                 parent_position = excluded.parent_position,
                 has_children = excluded.has_children,
                 updated_at = excluded.updated_at
              RETURNING ${issueSelectColumns}`,
                [
                  `issue-${ulid()}`,
                  input.repositoryId,
                  input.issueNumber,
                  input.title,
                  input.body,
                  input.url,
                  input.state,
                  input.githubCreatedAt.getTime(),
                  issueAuthor,
                  input.parent?.issueNumber ?? null,
                  input.parent?.issueUrl ?? null,
                  input.parentPosition,
                  input.hasChildren,
                  now,
                  now,
                ],
              )
              .pipe(Effect.mapError(toDatabaseError))

            const decoded = yield* decodeIssueRows(result)
            const row = decoded[0]
            if (!row) {
              return yield* new DatabaseError({
                message: "No issue returned from upsert",
              })
            }

            yield* sql`
              DELETE FROM issue_dependency WHERE issue_id = ${row.id}
            `.pipe(Effect.mapError(toDatabaseError))
            const dependencies = [
              ...new Map(
                input.blockedBy.map((dependency) => [
                  dependency.issueUrl,
                  dependency,
                ]),
              ).values(),
            ].sort(
              (left, right) =>
                left.issueNumber - right.issueNumber ||
                left.issueUrl.localeCompare(right.issueUrl),
            )
            for (const dependency of dependencies) {
              yield* sql
                .unsafe(
                  `INSERT INTO issue_dependency (
                 id, issue_id, blocking_issue_number,
                 blocking_issue_url, created_at
               ) VALUES (?, ?, ?, ?, ?)`,
                  [
                    `issue-dependency-${ulid()}`,
                    row.id,
                    dependency.issueNumber,
                    dependency.issueUrl,
                    now,
                  ],
                )
                .pipe(Effect.mapError(toDatabaseError))
            }

            return IssueRecord.make(toIssueRecord(row, dependencies))
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof DatabaseError ||
            error instanceof InvalidIssueInputError ||
            error instanceof RepositoryNotFoundError
              ? error
              : toDatabaseError(error),
          ),
        )
    })

    const listIssues = Effect.fn("DbService.listIssues")(function* (
      repositoryId: string,
    ) {
      yield* ensureRepositoryExists(repositoryId)

      const issues = yield* sql
        .unsafe(
          `SELECT ${issueSelectColumns}
             FROM issue WHERE repository_id = ? ORDER BY issue_number ASC`,
          [repositoryId],
        )
        .pipe(Effect.mapError(toDatabaseError))

      const dependencyRows = yield* sql
        .unsafe(
          `SELECT d.issue_id, d.blocking_issue_number,
               d.blocking_issue_url
             FROM issue_dependency d
             INNER JOIN issue i ON i.id = d.issue_id
             WHERE i.repository_id = ?
             ORDER BY d.blocking_issue_number ASC,
               d.blocking_issue_url ASC`,
          [repositoryId],
        )
        .pipe(Effect.mapError(toDatabaseError))
      const dependencies = yield* decodeIssueDependencyRows(dependencyRows)
      const dependenciesByIssue = new Map<string, IssueDependency[]>()
      for (const dependency of dependencies) {
        const records = dependenciesByIssue.get(dependency.issueId) ?? []
        records.push({
          issueNumber: dependency.issueNumber,
          issueUrl: dependency.issueUrl,
        })
        dependenciesByIssue.set(dependency.issueId, records)
      }

      const decodedIssues = yield* decodeIssueRows(issues)
      return decodedIssues.map((issue) =>
        IssueRecord.make(
          toIssueRecord(issue, dependenciesByIssue.get(issue.id) ?? []),
        ),
      )
    })

    const listWorkItemPullRequests = Effect.fn(
      "DbService.listWorkItemPullRequests",
    )(function* (repositoryId: string) {
      yield* ensureRepositoryExists(repositoryId)
      const rows = yield* sql
        .unsafe(
          `SELECT issue_number, pull_request_number
             FROM work_item
             WHERE repository_id = ? AND pull_request_number IS NOT NULL
             ORDER BY issue_number ASC, pull_request_number ASC`,
          [repositoryId],
        )
        .pipe(Effect.mapError(toDatabaseError))

      const decoded = yield* decodeWorkItemPullRequestRows(rows)
      return decoded.map((row) =>
        WorkItemPullRequest.make({
          issueNumber: row.issueNumber,
          pullRequestNumber: row.pullRequestNumber,
        }),
      )
    })

    const listUnfinishedCreatePrWorkItems = Effect.fn(
      "DbService.listUnfinishedCreatePrWorkItems",
    )(function* (repositoryId: string) {
      yield* ensureRepositoryExists(repositoryId)
      const rows = yield* sql
        .unsafe(
          `SELECT id, issue_number
             FROM work_item
             WHERE repository_id = ?
               AND state = 'create_pr'
             ORDER BY issue_number ASC, id ASC`,
          [repositoryId],
        )
        .pipe(Effect.mapError(toDatabaseError))

      const decoded = yield* decodeUnfinishedCreatePrWorkItemRows(rows)
      return decoded.map((row) =>
        UnfinishedCreatePrWorkItem.make({
          workItemId: row.workItemId,
          issueNumber: row.issueNumber,
        }),
      )
    })

    const deleteIssue = Effect.fn("DbService.deleteIssue")(function* (
      repositoryId: string,
      issueNumber: number,
    ) {
      yield* ensureRepositoryExists(repositoryId)
      yield* sql
        .unsafe(
          `DELETE FROM issue_dependency
             WHERE issue_id IN (
               SELECT id FROM issue
               WHERE repository_id = ? AND issue_number = ?
             )`,
          [repositoryId, issueNumber],
        )
        .pipe(Effect.mapError(toDatabaseError))
      yield* sql
        .unsafe(
          `DELETE FROM issue
             WHERE repository_id = ? AND issue_number = ?`,
          [repositoryId, issueNumber],
        )
        .pipe(Effect.mapError(toDatabaseError))
    })

    const markIssuesReconciled = Effect.fn("DbService.markIssuesReconciled")(
      function* (repositoryId: string, reconciledAt: Date) {
        const now = yield* Clock.currentTimeMillis
        const result = yield* sql
          .unsafe(
            `UPDATE repository
             SET issues_reconciled_at = ?, updated_at = ?
             WHERE id = ?
             RETURNING id`,
            [reconciledAt.getTime(), now, repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))

        if (!result[0]) {
          return yield* new RepositoryNotFoundError({ repositoryId })
        }
      },
    )

    const notifyIssuesChanged = Effect.fn("DbService.notifyIssuesChanged")(
      function* (repositoryId: string) {
        yield* publishIssuesChanged(repositoryId)
      },
    )

    const notifyWorkItemsChanged = Effect.fn(
      "DbService.notifyWorkItemsChanged",
    )(function* (repositoryId: string) {
      yield* publishWorkItemsChanged(repositoryId)
    })

    return DbService.of({
      repositoryChanges: repositoryChangesStream,
      issueChanges: issueChangesStream,
      workItemChanges: workItemChangesStream,
      notifyIssuesChanged,
      notifyWorkItemsChanged,
      getConfig,
      getBackendModelPrefs,
      getRepositoryBackendModelPrefs,
      updateConfig,
      countUnfinishedWorkItems,
      countBlockingUnfinishedForGlobalDefault,
      countBlockingUnfinishedForRepository,
      listSelectedOrInUseBackendIds,
      addRepository,
      updateRepositorySettings,
      pauseRepository,
      unpauseRepository,
      listRepositories,
      removeRepository,
      storeIssue,
      listIssues,
      listWorkItemPullRequests,
      listUnfinishedCreatePrWorkItems,
      deleteIssue,
      markIssuesReconciled,
    })
  }),
)
