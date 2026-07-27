import { Clock, Context, Effect, Layer, PubSub, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { ulid } from "ulidx"
import { isSelectableAgentBackendId } from "@ready-for-agent/agent-backend"
import {
  AgentBackendChangeBlockedError,
  DatabaseError,
  InvalidConfigInputError,
  InvalidIssueInputError,
  InvalidRepositoryInputError,
  InvalidRepositorySettingsError,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
  RepositoryHasRunningStepError,
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
  field: "githubOwner" | "githubRepo" | "localPath",
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
 * Unfinished Work Items block backend changes (includes Needs Human, paused,
 * Waiting for Worker Slot). Terminal complete/failed/abandoned do not.
 */
const isUnfinishedStateSql = (column = "state") =>
  `${column} NOT IN ('complete', 'failed', 'abandoned')`

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
const decodeWorkItemPullRequestRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(WorkItemPullRequestSqlRow))(
    rows,
  ).pipe(Effect.mapError(toSchemaDatabaseError))
const decodeRunningStepRows = (rows: ReadonlyArray<unknown>) =>
  Schema.decodeUnknownEffect(Schema.Array(RunningStepSqlRow))(rows).pipe(
    Effect.mapError(toSchemaDatabaseError),
  )

const repositorySelectColumns = `id, github_owner, github_repo, local_path, is_bare, paused,
             selected_agent_backend, default_model, default_thinking_level,
             review_model, review_thinking_level, backend_model_prefs, auto_merge,
             include_all_issue_authors, wait_for_ready_for_review_checks,
             issues_reconciled_at`

const issueSelectColumns = `id, repository_id, github_issue_number, title, body, url, state,
                github_created_at, issue_author, parent_github_issue_number,
                parent_github_issue_url, parent_position, has_children`

const toRepositoryRecord = (row: RepositorySqlRow): RepositoryRecord =>
  RepositoryRecord.make({
    id: row.id,
    githubOwner: row.githubOwner,
    githubRepo: row.githubRepo,
    localPath: row.localPath,
    isBare: row.isBare,
    paused: row.paused,
    selectedAgentBackend: row.selectedAgentBackend,
    defaultModel: row.defaultModel,
    defaultThinkingLevel: row.defaultThinkingLevel,
    reviewModel: row.reviewModel,
    reviewThinkingLevel: row.reviewThinkingLevel,
    autoMerge: row.autoMerge,
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
  githubIssueNumber: row.githubIssueNumber,
  title: row.title,
  body: row.body,
  url: row.url,
  state: row.state,
  githubCreatedAt: new Date(row.githubCreatedAt),
  issueAuthor: row.issueAuthor,
  parentPosition: row.parentPosition,
  hasChildren: row.hasChildren,
  parent:
    row.parentGithubIssueNumber === null || row.parentGithubIssueUrl === null
      ? null
      : {
          githubIssueNumber: row.parentGithubIssueNumber,
          githubIssueUrl: row.parentGithubIssueUrl,
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
  readonly updateConfig: (
    input: UpdateConfigInput,
  ) => Effect.Effect<
    ConfigRecord,
    InvalidConfigInputError | AgentBackendChangeBlockedError | DatabaseError
  >
  /**
   * Fleet-wide unfinished Work Item total (not terminal complete/failed/
   * abandoned; includes Needs Human, paused, and Waiting for Worker Slot).
   * Visibility/UI only — backend-change gates use scoped blocking counts
   * (inheriting repos for harness default; one repository for override).
   */
  readonly countUnfinishedWorkItems: Effect.Effect<number, DatabaseError>
  /**
   * Unfinished Work Items on Repositories that inherit the harness default
   * (override is null). Blocks changing Config.selectedAgentBackend when > 0.
   */
  readonly countBlockingUnfinishedForGlobalDefault: Effect.Effect<
    number,
    DatabaseError
  >
  /**
   * Unfinished Work Items on one Repository. Blocks changing that Repository's
   * Agent Backend override when > 0.
   */
  readonly countBlockingUnfinishedForRepository: (
    repositoryId: string,
  ) => Effect.Effect<number, DatabaseError>
  /**
   * Distinct Work Item PRs for one Repository (any Work Item state). Does not
   * apply Issue relevance filters (label, author, hierarchy) or Jobs-card
   * listKind partitions — total recorded pull requests only.
   */
  readonly countPullRequestsForRepository: (
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
    | RepositoryNotFoundError
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
  /**
   * Delete one issue. Does not publish `issueChanges`; call `notifyIssuesChanged`
   * after the mutation batch when UI/subscribers should refresh.
   */
  readonly deleteIssue: (
    repositoryId: string,
    githubIssueNumber: number,
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
     * Unfinished Work Items on Repositories that inherit the harness default
     * (override is null). These alone block changing the global default.
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
             WHERE ${isUnfinishedStateSql("wi.state")}
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
     * Unfinished Work Items on one Repository (blocks that repo's override change).
     */
    const countBlockingUnfinishedForRepository = (
      repositoryId: string,
    ): Effect.Effect<number, DatabaseError> =>
      Effect.gen(function* () {
        const rows = (yield* sql
          .unsafe(
            `SELECT COUNT(*) AS count FROM work_item
             WHERE repository_id = ?
               AND ${isUnfinishedStateSql()}`,
            [repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly {
          readonly count: number
        }[]
        return readCount(rows)
      }).pipe(Effect.withSpan("DbService.countBlockingUnfinishedForRepository"))

    /**
     * Distinct Work Item PR numbers for one Repository (all Work Item states).
     */
    const countPullRequestsForRepository = (
      repositoryId: string,
    ): Effect.Effect<number, DatabaseError> =>
      Effect.gen(function* () {
        const rows = (yield* sql
          .unsafe(
            `SELECT COUNT(DISTINCT github_pull_request_number) AS count
             FROM work_item
             WHERE repository_id = ?
               AND github_pull_request_number IS NOT NULL`,
            [repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly {
          readonly count: number
        }[]
        return readCount(rows)
      }).pipe(Effect.withSpan("DbService.countPullRequestsForRepository"))

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

      // Normalize model fields once; emptiness is enforced against the in-txn
      // backend-change flag so concurrent switches cannot clear a build model.
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
              // Gate on inheriting repos only. Explicit-override WIP does not
              // block the harness default change.
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
            } else if (defaultModel === null) {
              // Same-backend update requires a build model (in-txn authoritative).
              return yield* new InvalidConfigInputError({
                field: "defaultModel",
                message: "defaultModel cannot be empty",
              })
            }
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
                   created_at, updated_at
                 ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET
                   selected_agent_backend = excluded.selected_agent_backend,
                   default_model = excluded.default_model,
                   default_thinking_level = excluded.default_thinking_level,
                   review_model = excluded.review_model,
                   review_thinking_level = excluded.review_thinking_level,
                   backend_model_prefs = excluded.backend_model_prefs,
                   max_concurrent_agent_turns = excluded.max_concurrent_agent_turns,
                   max_concurrent_work_items = excluded.max_concurrent_work_items,
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
                tag === "InvalidConfigInputError"
              ) {
                return error as
                  | AgentBackendChangeBlockedError
                  | DatabaseError
                  | InvalidConfigInputError
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
      const githubOwner = yield* trimRequired(input.githubOwner, "githubOwner")
      const githubRepo = yield* trimRequired(input.githubRepo, "githubRepo")
      const localPath = yield* trimRequired(input.localPath, "localPath")
      const now = yield* Clock.currentTimeMillis
      const id = RepositoryId.make(`repo-${ulid()}`)

      const existingByGithub = yield* sql
        .unsafe(
          `SELECT id FROM repository
             WHERE lower(github_owner) = ? AND lower(github_repo) = ?
             LIMIT 1`,
          [githubOwner.toLowerCase(), githubRepo.toLowerCase()],
        )
        .pipe(Effect.mapError(toDatabaseError))

      if (existingByGithub[0]) {
        return yield* new RepositoryAlreadyExistsError({
          githubOwner,
          githubRepo,
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
               id, github_owner, github_repo, local_path, is_bare, paused,
               selected_agent_backend,
               default_model, default_thinking_level, review_model, review_thinking_level,
               backend_model_prefs,
               auto_merge, include_all_issue_authors, wait_for_ready_for_review_checks,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, '{}', ?, ?, ?, ?, ?)
             RETURNING ${repositorySelectColumns}`,
          [
            id,
            githubOwner,
            githubRepo,
            localPath,
            input.isBare,
            true,
            false,
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
                githubOwner,
                githubRepo,
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
      const now = yield* Clock.currentTimeMillis
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // Re-read harness default and repo row inside the txn so concurrent
            // config switches cannot mis-key prefs / flat columns.
            const configRows = yield* sql
              .unsafe(
                `SELECT selected_agent_backend AS selectedAgentBackend
                 FROM config WHERE id = 'default'`,
              )
              .pipe(Effect.mapError(toDatabaseError))
            const harnessDefault =
              (
                configRows[0] as
                  | { readonly selectedAgentBackend: string }
                  | undefined
              )?.selectedAgentBackend ?? "opencode"
            const existingRows = yield* sql
              .unsafe(
                `SELECT selected_agent_backend AS selectedAgentBackend,
                        backend_model_prefs AS backendModelPrefs
                 FROM repository WHERE id = ?`,
                [input.repositoryId],
              )
              .pipe(Effect.mapError(toDatabaseError))
            const existing = existingRows[0] as
              | {
                  readonly selectedAgentBackend: string | null
                  readonly backendModelPrefs: string
                }
              | undefined
            if (!existing) {
              return yield* new RepositoryNotFoundError({
                repositoryId: input.repositoryId,
              })
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
             SET paused = ?,
                 selected_agent_backend = ?,
                 default_model = ?,
                 default_thinking_level = ?,
                 review_model = ?,
                 review_thinking_level = ?,
                 backend_model_prefs = ?,
                 auto_merge = ?,
                 include_all_issue_authors = ?,
                 wait_for_ready_for_review_checks = ?,
                 updated_at = ?
             WHERE id = ?
             RETURNING ${repositorySelectColumns}`,
                [
                  input.paused,
                  nextOverride,
                  defaultModel,
                  defaultThinkingLevel,
                  reviewModel,
                  reviewThinkingLevel,
                  backendModelPrefs,
                  input.autoMerge,
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
                tag === "InvalidRepositorySettingsError"
              ) {
                return error as
                  | RepositoryNotFoundError
                  | DatabaseError
                  | AgentBackendChangeBlockedError
                  | InvalidRepositorySettingsError
              }
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
           ORDER BY lower(github_owner) ASC, lower(github_repo) ASC`,
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
      if (
        !Number.isSafeInteger(input.githubIssueNumber) ||
        input.githubIssueNumber <= 0
      ) {
        return yield* new InvalidIssueInputError({
          field: "githubIssueNumber",
          message: "githubIssueNumber must be a positive integer",
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
        (!Number.isSafeInteger(input.parent.githubIssueNumber) ||
          input.parent.githubIssueNumber <= 0 ||
          !URL.canParse(input.parent.githubIssueUrl))
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
          !Number.isSafeInteger(dependency.githubIssueNumber) ||
          dependency.githubIssueNumber <= 0
        ) {
          return yield* new InvalidIssueInputError({
            field: "blockedBy",
            message: "blockedBy issue numbers must be positive integers",
          })
        }
        if (!URL.canParse(dependency.githubIssueUrl)) {
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
               id, repository_id, github_issue_number, title, body, url, state,
                github_created_at, issue_author, parent_github_issue_number,
                 parent_github_issue_url, parent_position, has_children,
                 created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repository_id, github_issue_number) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               url = excluded.url,
                state = excluded.state,
                github_created_at = excluded.github_created_at,
                 issue_author = excluded.issue_author,
                 parent_github_issue_number = excluded.parent_github_issue_number,
                 parent_github_issue_url = excluded.parent_github_issue_url,
                 parent_position = excluded.parent_position,
                 has_children = excluded.has_children,
                 updated_at = excluded.updated_at
              RETURNING ${issueSelectColumns}`,
                [
                  `issue-${ulid()}`,
                  input.repositoryId,
                  input.githubIssueNumber,
                  input.title,
                  input.body,
                  input.url,
                  input.state,
                  input.githubCreatedAt.getTime(),
                  issueAuthor,
                  input.parent?.githubIssueNumber ?? null,
                  input.parent?.githubIssueUrl ?? null,
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
                  dependency.githubIssueUrl,
                  dependency,
                ]),
              ).values(),
            ].sort(
              (left, right) =>
                left.githubIssueNumber - right.githubIssueNumber ||
                left.githubIssueUrl.localeCompare(right.githubIssueUrl),
            )
            for (const dependency of dependencies) {
              yield* sql
                .unsafe(
                  `INSERT INTO issue_dependency (
                 id, issue_id, blocking_github_issue_number,
                 blocking_github_issue_url, created_at
               ) VALUES (?, ?, ?, ?, ?)`,
                  [
                    `issue-dependency-${ulid()}`,
                    row.id,
                    dependency.githubIssueNumber,
                    dependency.githubIssueUrl,
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
             FROM issue WHERE repository_id = ? ORDER BY github_issue_number ASC`,
          [repositoryId],
        )
        .pipe(Effect.mapError(toDatabaseError))

      const dependencyRows = yield* sql
        .unsafe(
          `SELECT d.issue_id, d.blocking_github_issue_number,
               d.blocking_github_issue_url
             FROM issue_dependency d
             INNER JOIN issue i ON i.id = d.issue_id
             WHERE i.repository_id = ?
             ORDER BY d.blocking_github_issue_number ASC,
               d.blocking_github_issue_url ASC`,
          [repositoryId],
        )
        .pipe(Effect.mapError(toDatabaseError))
      const dependencies = yield* decodeIssueDependencyRows(dependencyRows)
      const dependenciesByIssue = new Map<string, IssueDependency[]>()
      for (const dependency of dependencies) {
        const records = dependenciesByIssue.get(dependency.issueId) ?? []
        records.push({
          githubIssueNumber: dependency.githubIssueNumber,
          githubIssueUrl: dependency.githubIssueUrl,
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
          `SELECT github_issue_number, github_pull_request_number
             FROM work_item
             WHERE repository_id = ? AND github_pull_request_number IS NOT NULL
             ORDER BY github_issue_number ASC, github_pull_request_number ASC`,
          [repositoryId],
        )
        .pipe(Effect.mapError(toDatabaseError))

      const decoded = yield* decodeWorkItemPullRequestRows(rows)
      return decoded.map((row) =>
        WorkItemPullRequest.make({
          githubIssueNumber: row.githubIssueNumber,
          githubPullRequestNumber: row.githubPullRequestNumber,
        }),
      )
    })

    const deleteIssue = Effect.fn("DbService.deleteIssue")(function* (
      repositoryId: string,
      githubIssueNumber: number,
    ) {
      yield* ensureRepositoryExists(repositoryId)
      yield* sql
        .unsafe(
          `DELETE FROM issue_dependency
             WHERE issue_id IN (
               SELECT id FROM issue
               WHERE repository_id = ? AND github_issue_number = ?
             )`,
          [repositoryId, githubIssueNumber],
        )
        .pipe(Effect.mapError(toDatabaseError))
      yield* sql
        .unsafe(
          `DELETE FROM issue
             WHERE repository_id = ? AND github_issue_number = ?`,
          [repositoryId, githubIssueNumber],
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
      updateConfig,
      countUnfinishedWorkItems,
      countBlockingUnfinishedForGlobalDefault,
      countBlockingUnfinishedForRepository,
      countPullRequestsForRepository,
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
      deleteIssue,
      markIssuesReconciled,
    })
  }),
)
