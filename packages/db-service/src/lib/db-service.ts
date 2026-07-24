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
  type InvalidRepositorySettingsError,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
  RepositoryHasRunningStepError,
  RepositoryNotFoundError,
} from "./errors.js"
import {
  type AddRepositoryInput,
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
} from "./types.js"

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
             default_model, default_thinking_level, review_model, review_thinking_level, auto_merge,
             include_all_issue_authors, issues_reconciled_at`

const issueSelectColumns = `id, repository_id, github_issue_number, title, body, url, state,
                github_created_at, issue_author, parent_github_issue_number,
                parent_github_issue_url, parent_position, has_children`

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
  readonly updateConfig: (
    input: UpdateConfigInput,
  ) => Effect.Effect<
    ConfigRecord,
    InvalidConfigInputError | AgentBackendChangeBlockedError | DatabaseError
  >
  readonly countUnfinishedWorkItems: Effect.Effect<number, DatabaseError>
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
    InvalidRepositorySettingsError | RepositoryNotFoundError | DatabaseError
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
                    review_model, review_thinking_level,
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

    const countUnfinishedWorkItems: Effect.Effect<number, DatabaseError> =
      Effect.gen(function* () {
        const rows = (yield* sql
          .unsafe(
            `SELECT COUNT(*) AS count FROM work_item
             WHERE state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')`,
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly {
          readonly count: number
        }[]
        const count = rows[0]?.count
        return typeof count === "number" && Number.isFinite(count) ? count : 0
      }).pipe(Effect.withSpan("DbService.countUnfinishedWorkItems"))

    const getConfig: Effect.Effect<ConfigRecord, DatabaseError> = Effect.gen(
      function* () {
        const now = yield* Clock.currentTimeMillis
        yield* sql
          .unsafe(
            `INSERT OR IGNORE INTO config (
               id, selected_agent_backend, default_model, default_thinking_level,
               review_model, review_thinking_level,
               max_concurrent_agent_turns, max_concurrent_work_items,
               created_at, updated_at
             ) VALUES ('default', 'opencode', NULL, NULL, NULL, NULL, 2, 5, ?, ?)`,
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
        return toConfigRecord(row)
      },
    ).pipe(Effect.withSpan("DbService.getConfig"))

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

      const current = yield* getConfig
      const backendChanging =
        selectedAgentBackend !== current.selectedAgentBackend

      if (backendChanging) {
        const unfinished = yield* countUnfinishedWorkItems
        if (unfinished > 0) {
          return yield* new AgentBackendChangeBlockedError({
            message: `Cannot change Agent Backend while ${unfinished} Work Item(s) are unfinished`,
            unfinishedWorkItemCount: unfinished,
          })
        }
      }

      let defaultModel: string | null
      let defaultThinkingLevel: string | null
      let reviewModel: string | null
      let reviewThinkingLevel: string | null

      if (backendChanging) {
        defaultModel = null
        defaultThinkingLevel = null
        reviewModel = null
        reviewThinkingLevel = null
      } else {
        const trimmedDefaultModel = (input.defaultModel ?? "").trim()
        if (trimmedDefaultModel.length === 0) {
          return yield* new InvalidConfigInputError({
            field: "defaultModel",
            message: "defaultModel cannot be empty",
          })
        }
        defaultModel = trimmedDefaultModel
        defaultThinkingLevel = yield* normalizeOptionalConfigSetting(
          input.defaultThinkingLevel,
        )
        reviewModel = yield* normalizeOptionalConfigSetting(input.reviewModel)
        reviewThinkingLevel = yield* normalizeOptionalConfigSetting(
          input.reviewThinkingLevel,
        )
      }

      const now = yield* Clock.currentTimeMillis
      const rows = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            if (backendChanging) {
              yield* sql.unsafe(
                `UPDATE repository SET
                   default_model = NULL,
                   default_thinking_level = NULL,
                   review_model = NULL,
                   review_thinking_level = NULL,
                   updated_at = ?`,
                [now],
              )
            }
            return yield* sql.unsafe(
              `INSERT INTO config (
                   id, selected_agent_backend, default_model, default_thinking_level,
                   review_model, review_thinking_level,
                   max_concurrent_agent_turns, max_concurrent_work_items,
                   created_at, updated_at
                 ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET
                   selected_agent_backend = excluded.selected_agent_backend,
                   default_model = excluded.default_model,
                   default_thinking_level = excluded.default_thinking_level,
                   review_model = excluded.review_model,
                   review_thinking_level = excluded.review_thinking_level,
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
                maxConcurrentAgentTurns,
                maxConcurrentWorkItems,
                now,
                now,
              ],
            )
          }),
        )
        .pipe(Effect.mapError(toDatabaseError))
      const decoded = yield* decodeConfigRows(rows)
      const row = decoded[0]
      if (!row) {
        return yield* new DatabaseError({
          message: "No config returned from update",
        })
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
               default_model, default_thinking_level, review_model, review_thinking_level,
               auto_merge, include_all_issue_authors, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
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

      const repository = RepositoryRecord.make(row)
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
      const now = yield* Clock.currentTimeMillis
      const result = yield* sql
        .unsafe(
          `UPDATE repository
             SET paused = ?,
                 default_model = ?,
                 default_thinking_level = ?,
                 review_model = ?,
                 review_thinking_level = ?,
                 auto_merge = ?,
                 include_all_issue_authors = ?,
                 updated_at = ?
             WHERE id = ?
             RETURNING ${repositorySelectColumns}`,
          [
            input.paused,
            defaultModel,
            defaultThinkingLevel,
            reviewModel,
            reviewThinkingLevel,
            input.autoMerge,
            input.includeAllIssueAuthors,
            now,
            input.repositoryId,
          ],
        )
        .pipe(Effect.mapError(toDatabaseError))

      const decoded = yield* decodeRepositoryRows(result)
      const row = decoded[0]
      if (!row) {
        return yield* new RepositoryNotFoundError({
          repositoryId: input.repositoryId,
        })
      }

      const repository = RepositoryRecord.make(row)
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

        const repository = RepositoryRecord.make(row)
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
      return decoded.map((row) => RepositoryRecord.make(row))
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
      updateConfig,
      countUnfinishedWorkItems,
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
