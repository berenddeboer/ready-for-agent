import { Clock, Context, Effect, Layer, PubSub, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { ulid } from "ulidx"
import {
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
import type {
  AddRepositoryInput,
  ConfigRecord,
  IssueDependency,
  IssueRecord,
  RepositoryRecord,
  StoreIssueInput,
  UpdateConfigInput,
  UpdateRepositorySettingsInput,
  WorkItemPullRequest,
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

const toRecord = (row: {
  id: string
  githubOwner: string
  githubRepo: string
  localPath: string
  isBare: boolean | number
  paused: boolean | number
  defaultModel: string | null
  defaultVariant: string | null
  reviewModel: string | null
  reviewVariant: string | null
  autoMerge: boolean | number
  issuesReconciledAt: number | null
}): RepositoryRecord => ({
  id: row.id,
  githubOwner: row.githubOwner,
  githubRepo: row.githubRepo,
  localPath: row.localPath,
  isBare: Boolean(row.isBare),
  paused: Boolean(row.paused),
  defaultModel: row.defaultModel,
  defaultVariant: row.defaultVariant,
  reviewModel: row.reviewModel,
  reviewVariant: row.reviewVariant,
  autoMerge: Boolean(row.autoMerge),
  issuesReconciledAt:
    row.issuesReconciledAt === null ? null : new Date(row.issuesReconciledAt),
})

type RepositoryRow = {
  id: string
  github_owner: string
  github_repo: string
  local_path: string
  is_bare: boolean | number
  paused: boolean | number
  default_model: string | null
  default_variant: string | null
  review_model: string | null
  review_variant: string | null
  auto_merge: boolean | number
  issues_reconciled_at: number | null
}

const repositorySelectColumns = `id, github_owner, github_repo, local_path, is_bare, paused,
             default_model, default_variant, review_model, review_variant, auto_merge, issues_reconciled_at`

const toRecordFromRow = (row: RepositoryRow): RepositoryRecord =>
  toRecord({
    id: row.id,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    localPath: row.local_path,
    isBare: row.is_bare,
    paused: row.paused,
    defaultModel: row.default_model,
    defaultVariant: row.default_variant,
    reviewModel: row.review_model,
    reviewVariant: row.review_variant,
    autoMerge: row.auto_merge,
    issuesReconciledAt: row.issues_reconciled_at,
  })

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

const toIssueRecord = (row: {
  id: string
  repositoryId: string
  githubIssueNumber: number
  title: string
  body: string
  url: string
  state: "OPEN" | "CLOSED"
  githubCreatedAt: number
  parentGithubIssueNumber: number | null
  parentGithubIssueUrl: string | null
  parentPosition: number | null
  hasChildren: number | boolean
  blockedBy: readonly IssueDependency[]
}): IssueRecord => ({
  id: row.id,
  repositoryId: row.repositoryId,
  githubIssueNumber: row.githubIssueNumber,
  title: row.title,
  body: row.body,
  url: row.url,
  state: row.state,
  githubCreatedAt: new Date(row.githubCreatedAt),
  parentPosition: row.parentPosition,
  hasChildren: Boolean(row.hasChildren),
  parent:
    row.parentGithubIssueNumber === null || row.parentGithubIssueUrl === null
      ? null
      : {
          githubIssueNumber: row.parentGithubIssueNumber,
          githubIssueUrl: row.parentGithubIssueUrl,
        },
  blockedBy: row.blockedBy,
})

const toDatabaseError = (error: SqlError) =>
  new DatabaseError({
    message: `Database error: ${formatSqlError(error)}`,
    cause: error,
  })

export interface DbServiceShape {
  readonly repositoryChanges: Stream.Stream<void>
  readonly issueChanges: Stream.Stream<string>
  readonly workItemChanges: Stream.Stream<string>
  readonly notifyIssuesChanged: (repositoryId: string) => Effect.Effect<void>
  readonly notifyWorkItemsChanged: (repositoryId: string) => Effect.Effect<void>
  readonly getConfig: Effect.Effect<ConfigRecord, DatabaseError>
  readonly updateConfig: (
    input: UpdateConfigInput,
  ) => Effect.Effect<ConfigRecord, InvalidConfigInputError | DatabaseError>
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
  readonly deleteIssue: (
    repositoryId: string,
    githubIssueNumber: number,
  ) => Effect.Effect<void, RepositoryNotFoundError | DatabaseError>
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
 * leave zombie workers publishing to a bus nobody listens to).
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

    const getConfig: Effect.Effect<ConfigRecord, DatabaseError> = Effect.gen(
      function* () {
        const now = Date.now()
        yield* sql
          .unsafe(
            `INSERT OR IGNORE INTO config (
               id, default_model, default_variant, review_model, review_variant,
               created_at, updated_at
             ) VALUES ('default', 'opencode/deepseek-v4-flash-free', 'low', NULL, NULL, ?, ?)`,
            [now, now],
          )
          .pipe(Effect.mapError(toDatabaseError))

        const rows = yield* sql
          .unsafe(
            `SELECT default_model, default_variant, review_model, review_variant
             FROM config WHERE id = 'default'`,
          )
          .pipe(Effect.mapError(toDatabaseError))
        const row = rows[0] as
          | {
              default_model: string
              default_variant: string
              review_model: string | null
              review_variant: string | null
            }
          | undefined
        if (!row) {
          return yield* new DatabaseError({
            message: "No config returned after initialization",
          })
        }
        return {
          defaultModel: row.default_model,
          defaultVariant: row.default_variant,
          reviewModel: row.review_model,
          reviewVariant: row.review_variant,
        }
      },
    )

    const updateConfig = (
      input: UpdateConfigInput,
    ): Effect.Effect<ConfigRecord, InvalidConfigInputError | DatabaseError> =>
      Effect.gen(function* () {
        const defaultModel = input.defaultModel.trim()
        if (defaultModel.length === 0) {
          return yield* new InvalidConfigInputError({
            field: "defaultModel",
            message: "defaultModel cannot be empty",
          })
        }
        const defaultVariant = input.defaultVariant.trim()
        if (defaultVariant.length === 0) {
          return yield* new InvalidConfigInputError({
            field: "defaultVariant",
            message: "defaultVariant cannot be empty",
          })
        }
        const reviewModel = yield* normalizeOptionalConfigSetting(
          input.reviewModel,
        )
        const reviewVariant = yield* normalizeOptionalConfigSetting(
          input.reviewVariant,
        )

        const now = Date.now()
        const rows = yield* sql
          .unsafe(
            `INSERT INTO config (
               id, default_model, default_variant, review_model, review_variant,
               created_at, updated_at
             ) VALUES ('default', ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               default_model = excluded.default_model,
               default_variant = excluded.default_variant,
               review_model = excluded.review_model,
               review_variant = excluded.review_variant,
               updated_at = excluded.updated_at
             RETURNING default_model, default_variant, review_model, review_variant`,
            [
              defaultModel,
              defaultVariant,
              reviewModel,
              reviewVariant,
              now,
              now,
            ],
          )
          .pipe(Effect.mapError(toDatabaseError))
        const row = rows[0] as
          | {
              default_model: string
              default_variant: string
              review_model: string | null
              review_variant: string | null
            }
          | undefined
        if (!row) {
          return yield* new DatabaseError({
            message: "No config returned from update",
          })
        }
        return {
          defaultModel: row.default_model,
          defaultVariant: row.default_variant,
          reviewModel: row.review_model,
          reviewVariant: row.review_variant,
        }
      })

    const addRepository = (
      input: AddRepositoryInput,
    ): Effect.Effect<
      RepositoryRecord,
      | InvalidRepositoryInputError
      | RepositoryAlreadyExistsError
      | LocalPathInUseError
      | DatabaseError
    > =>
      Effect.gen(function* () {
        const githubOwner = yield* trimRequired(
          input.githubOwner,
          "githubOwner",
        )
        const githubRepo = yield* trimRequired(input.githubRepo, "githubRepo")
        const localPath = yield* trimRequired(input.localPath, "localPath")
        const now = Date.now()
        const id = `repo-${ulid()}`

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

        const existingByPath = yield* sql
          .unsafe("SELECT id FROM repository WHERE local_path = ? LIMIT 1", [
            localPath,
          ])
          .pipe(Effect.mapError(toDatabaseError))

        if (existingByPath[0]) {
          return yield* new LocalPathInUseError({ localPath })
        }

        const result = yield* sql
          .unsafe(
            `INSERT INTO repository (
               id, github_owner, github_repo, local_path, is_bare, paused,
               default_model, default_variant, review_model, review_variant,
               auto_merge, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
             RETURNING ${repositorySelectColumns}`,
            [
              id,
              githubOwner,
              githubRepo,
              localPath,
              input.isBare,
              true,
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

        const row = result[0] as RepositoryRow | undefined
        if (!row) {
          return yield* new DatabaseError({
            message: "No repository returned from insert",
          })
        }

        const repository = toRecordFromRow(row)
        yield* publishRepositoryChanged()
        return repository
      })

    const updateRepositorySettings = (
      input: UpdateRepositorySettingsInput,
    ): Effect.Effect<
      RepositoryRecord,
      InvalidRepositorySettingsError | RepositoryNotFoundError | DatabaseError
    > =>
      Effect.gen(function* () {
        const defaultModel = yield* normalizeOptionalSetting(input.defaultModel)
        const defaultVariant = yield* normalizeOptionalSetting(
          input.defaultVariant,
        )
        const reviewModel = yield* normalizeOptionalSetting(input.reviewModel)
        const reviewVariant = yield* normalizeOptionalSetting(
          input.reviewVariant,
        )
        const now = Date.now()
        const result = yield* sql
          .unsafe(
            `UPDATE repository
             SET paused = ?,
                 default_model = ?,
                 default_variant = ?,
                 review_model = ?,
                 review_variant = ?,
                 auto_merge = ?,
                 updated_at = ?
             WHERE id = ?
             RETURNING ${repositorySelectColumns}`,
            [
              input.paused,
              defaultModel,
              defaultVariant,
              reviewModel,
              reviewVariant,
              input.autoMerge,
              now,
              input.repositoryId,
            ],
          )
          .pipe(Effect.mapError(toDatabaseError))

        const row = result[0] as RepositoryRow | undefined
        if (!row) {
          return yield* new RepositoryNotFoundError({
            repositoryId: input.repositoryId,
          })
        }

        const repository = toRecordFromRow(row)
        yield* publishRepositoryChanged()
        return repository
      })

    const setRepositoryPaused = (
      repositoryId: string,
      paused: boolean,
    ): Effect.Effect<
      RepositoryRecord,
      RepositoryNotFoundError | DatabaseError
    > =>
      Effect.gen(function* () {
        const now = Date.now()
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

        const row = result[0] as RepositoryRow | undefined
        if (!row) {
          return yield* new RepositoryNotFoundError({ repositoryId })
        }

        const repository = toRecordFromRow(row)
        yield* publishRepositoryChanged()
        return repository
      })

    const pauseRepository = (
      repositoryId: string,
    ): Effect.Effect<
      RepositoryRecord,
      RepositoryNotFoundError | DatabaseError
    > => setRepositoryPaused(repositoryId, true)

    const unpauseRepository = (
      repositoryId: string,
    ): Effect.Effect<
      RepositoryRecord,
      RepositoryNotFoundError | DatabaseError
    > => setRepositoryPaused(repositoryId, false)

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

      return (repositories as ReadonlyArray<RepositoryRow>).map(toRecordFromRow)
    })

    const ensureRepositoryExists = (
      repositoryId: string,
    ): Effect.Effect<void, RepositoryNotFoundError | DatabaseError> =>
      Effect.gen(function* () {
        const repository = yield* sql
          .unsafe("SELECT id FROM repository WHERE id = ? LIMIT 1", [
            repositoryId,
          ])
          .pipe(Effect.mapError(toDatabaseError))

        if (!repository[0]) {
          return yield* new RepositoryNotFoundError({ repositoryId })
        }
      })

    const removeRepository = (
      repositoryId: string,
    ): Effect.Effect<
      void,
      RepositoryNotFoundError | RepositoryHasRunningStepError | DatabaseError
    > =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const running = (yield* sql.unsafe(
                `SELECT step_run.id AS step_run_id, step_run.work_item_id AS work_item_id
                 FROM step_run
                 INNER JOIN work_item ON work_item.id = step_run.work_item_id
                 WHERE work_item.repository_id = ?
                   AND step_run.status = 'running'
                 ORDER BY step_run.queued_at ASC, step_run.id ASC
                 LIMIT 1`,
                [repositoryId],
              )) as readonly {
                readonly step_run_id: string
                readonly work_item_id: string
              }[]

              if (running[0]) {
                return yield* new RepositoryHasRunningStepError({
                  repositoryId,
                  stepRunId: running[0].step_run_id,
                  workItemId: running[0].work_item_id,
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

              yield* sql.unsafe(
                `DELETE FROM work_item WHERE repository_id = ?`,
                [repositoryId],
              )

              yield* sql.unsafe(
                `DELETE FROM issue_dependency
               WHERE issue_id IN (
                 SELECT id FROM issue WHERE repository_id = ?
               )`,
                [repositoryId],
              )
              yield* sql.unsafe("DELETE FROM issue WHERE repository_id = ?", [
                repositoryId,
              ])
              const result = yield* sql.unsafe(
                "DELETE FROM repository WHERE id = ? RETURNING id",
                [repositoryId],
              )

              if (!result[0]) {
                return yield* new RepositoryNotFoundError({ repositoryId })
              }
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              error instanceof RepositoryNotFoundError ||
              error instanceof RepositoryHasRunningStepError
                ? error
                : toDatabaseError(error),
            ),
          )
        yield* publishRepositoryChanged()
        yield* publishWorkItemsChanged(repositoryId)
      })

    const storeIssue = (
      input: StoreIssueInput,
    ): Effect.Effect<
      IssueRecord,
      InvalidIssueInputError | RepositoryNotFoundError | DatabaseError
    > =>
      Effect.gen(function* () {
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

        const now = Date.now()
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const result = yield* sql
                .unsafe(
                  `INSERT INTO issue (
               id, repository_id, github_issue_number, title, body, url, state,
                github_created_at, parent_github_issue_number,
                 parent_github_issue_url, parent_position, has_children,
                 created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repository_id, github_issue_number) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               url = excluded.url,
                state = excluded.state,
                github_created_at = excluded.github_created_at,
                 parent_github_issue_number = excluded.parent_github_issue_number,
                 parent_github_issue_url = excluded.parent_github_issue_url,
                 parent_position = excluded.parent_position,
                 has_children = excluded.has_children,
                 updated_at = excluded.updated_at
              RETURNING id, repository_id, github_issue_number, title, body, url, state,
                github_created_at, parent_github_issue_number,
                 parent_github_issue_url, parent_position, has_children`,
                  [
                    `issue-${ulid()}`,
                    input.repositoryId,
                    input.githubIssueNumber,
                    input.title,
                    input.body,
                    input.url,
                    input.state,
                    input.githubCreatedAt.getTime(),
                    input.parent?.githubIssueNumber ?? null,
                    input.parent?.githubIssueUrl ?? null,
                    input.parentPosition,
                    input.hasChildren,
                    now,
                    now,
                  ],
                )
                .pipe(Effect.mapError(toDatabaseError))

              const row = result[0] as
                | {
                    id: string
                    repository_id: string
                    github_issue_number: number
                    title: string
                    body: string
                    url: string
                    state: "OPEN" | "CLOSED"
                    github_created_at: number
                    parent_github_issue_number: number | null
                    parent_github_issue_url: string | null
                    parent_position: number | null
                    has_children: number
                  }
                | undefined
              if (!row) {
                return yield* new DatabaseError({
                  message: "No issue returned from upsert",
                })
              }

              yield* sql
                .unsafe("DELETE FROM issue_dependency WHERE issue_id = ?", [
                  row.id,
                ])
                .pipe(Effect.mapError(toDatabaseError))
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

              return toIssueRecord({
                id: row.id,
                repositoryId: row.repository_id,
                githubIssueNumber: row.github_issue_number,
                title: row.title,
                body: row.body,
                url: row.url,
                state: row.state,
                githubCreatedAt: row.github_created_at,
                parentGithubIssueNumber: row.parent_github_issue_number,
                parentGithubIssueUrl: row.parent_github_issue_url,
                parentPosition: row.parent_position,
                hasChildren: row.has_children,
                blockedBy: dependencies,
              })
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              error instanceof DatabaseError ? error : toDatabaseError(error),
            ),
          )
      })

    const listIssues = (
      repositoryId: string,
    ): Effect.Effect<
      readonly IssueRecord[],
      RepositoryNotFoundError | DatabaseError
    > =>
      Effect.gen(function* () {
        yield* ensureRepositoryExists(repositoryId)

        const issues = yield* sql
          .unsafe(
            `SELECT id, repository_id, github_issue_number, title, body, url, state,
                github_created_at, parent_github_issue_number,
                parent_github_issue_url, parent_position, has_children
             FROM issue WHERE repository_id = ? ORDER BY github_issue_number ASC`,
            [repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))

        const dependencies = yield* sql
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
        const dependenciesByIssue = new Map<string, IssueDependency[]>()
        for (const dependency of dependencies as ReadonlyArray<{
          issue_id: string
          blocking_github_issue_number: number
          blocking_github_issue_url: string
        }>) {
          const records = dependenciesByIssue.get(dependency.issue_id) ?? []
          records.push({
            githubIssueNumber: dependency.blocking_github_issue_number,
            githubIssueUrl: dependency.blocking_github_issue_url,
          })
          dependenciesByIssue.set(dependency.issue_id, records)
        }

        return (
          issues as ReadonlyArray<{
            id: string
            repository_id: string
            github_issue_number: number
            title: string
            body: string
            url: string
            state: "OPEN" | "CLOSED"
            github_created_at: number
            parent_github_issue_number: number | null
            parent_github_issue_url: string | null
            parent_position: number | null
            has_children: number
          }>
        ).map((issue) =>
          toIssueRecord({
            id: issue.id,
            repositoryId: issue.repository_id,
            githubIssueNumber: issue.github_issue_number,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            state: issue.state,
            githubCreatedAt: issue.github_created_at,
            parentGithubIssueNumber: issue.parent_github_issue_number,
            parentGithubIssueUrl: issue.parent_github_issue_url,
            parentPosition: issue.parent_position,
            hasChildren: issue.has_children,
            blockedBy: dependenciesByIssue.get(issue.id) ?? [],
          }),
        )
      })

    const listWorkItemPullRequests = (
      repositoryId: string,
    ): Effect.Effect<
      readonly WorkItemPullRequest[],
      RepositoryNotFoundError | DatabaseError
    > =>
      Effect.gen(function* () {
        yield* ensureRepositoryExists(repositoryId)
        const rows = (yield* sql
          .unsafe(
            `SELECT github_issue_number, github_pull_request_number
             FROM work_item
             WHERE repository_id = ? AND github_pull_request_number IS NOT NULL
             ORDER BY github_issue_number ASC, github_pull_request_number ASC`,
            [repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))) as readonly {
          readonly github_issue_number: number
          readonly github_pull_request_number: number
        }[]

        return rows.map((row) => ({
          githubIssueNumber: row.github_issue_number,
          githubPullRequestNumber: row.github_pull_request_number,
        }))
      })

    const deleteIssue = (
      repositoryId: string,
      githubIssueNumber: number,
    ): Effect.Effect<void, RepositoryNotFoundError | DatabaseError> =>
      Effect.gen(function* () {
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

    const markIssuesReconciled = (
      repositoryId: string,
      reconciledAt: Date,
    ): Effect.Effect<void, RepositoryNotFoundError | DatabaseError> =>
      Effect.gen(function* () {
        const result = yield* sql
          .unsafe(
            `UPDATE repository
             SET issues_reconciled_at = ?, updated_at = ?
             WHERE id = ?
             RETURNING id`,
            [reconciledAt.getTime(), Date.now(), repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))

        if (!result[0]) {
          return yield* new RepositoryNotFoundError({ repositoryId })
        }
      })

    const notifyIssuesChanged = (repositoryId: string): Effect.Effect<void> =>
      publishIssuesChanged(repositoryId)

    const notifyWorkItemsChanged = (
      repositoryId: string,
    ): Effect.Effect<void> => publishWorkItemsChanged(repositoryId)

    return DbService.of({
      repositoryChanges: repositoryChangesStream,
      issueChanges: issueChangesStream,
      workItemChanges: workItemChangesStream,
      notifyIssuesChanged,
      notifyWorkItemsChanged,
      getConfig,
      updateConfig,
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
