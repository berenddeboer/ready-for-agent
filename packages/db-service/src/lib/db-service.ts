import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { ulid } from "ulidx"
import {
  DatabaseError,
  InvalidConfigInputError,
  InvalidIssueInputError,
  InvalidRepositoryInputError,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
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
  issuesReconciledAt: number | null
}): RepositoryRecord => ({
  id: row.id,
  githubOwner: row.githubOwner,
  githubRepo: row.githubRepo,
  localPath: row.localPath,
  isBare: Boolean(row.isBare),
  paused: Boolean(row.paused),
  issuesReconciledAt:
    row.issuesReconciledAt === null ? null : new Date(row.issuesReconciledAt),
})

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
  readonly listRepositories: Effect.Effect<
    readonly RepositoryRecord[],
    DatabaseError
  >
  readonly removeRepository: (
    repositoryId: string,
  ) => Effect.Effect<void, RepositoryNotFoundError | DatabaseError>
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

export const DbServiceLive = Layer.effect(
  DbService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const repositoryChanges = yield* PubSub.unbounded<void>()

    const getConfig: Effect.Effect<ConfigRecord, DatabaseError> = Effect.gen(
      function* () {
        const now = Date.now()
        yield* sql
          .unsafe(
            `INSERT OR IGNORE INTO config (
               id, default_model, default_variant, created_at, updated_at
             ) VALUES ('default', 'opencode/deepseek-v4-flash-free', 'low', ?, ?)`,
            [now, now],
          )
          .pipe(Effect.mapError(toDatabaseError))

        const rows = yield* sql
          .unsafe(
            `SELECT default_model, default_variant
             FROM config WHERE id = 'default'`,
          )
          .pipe(Effect.mapError(toDatabaseError))
        const row = rows[0] as
          | { default_model: string; default_variant: string }
          | undefined
        if (!row) {
          return yield* new DatabaseError({
            message: "No config returned after initialization",
          })
        }
        return {
          defaultModel: row.default_model,
          defaultVariant: row.default_variant,
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

        const now = Date.now()
        const rows = yield* sql
          .unsafe(
            `INSERT INTO config (
               id, default_model, default_variant, created_at, updated_at
             ) VALUES ('default', ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               default_model = excluded.default_model,
               default_variant = excluded.default_variant,
               updated_at = excluded.updated_at
             RETURNING default_model, default_variant`,
            [defaultModel, defaultVariant, now, now],
          )
          .pipe(Effect.mapError(toDatabaseError))
        const row = rows[0] as
          | { default_model: string; default_variant: string }
          | undefined
        if (!row) {
          return yield* new DatabaseError({
            message: "No config returned from update",
          })
        }
        return {
          defaultModel: row.default_model,
          defaultVariant: row.default_variant,
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
               id, github_owner, github_repo, local_path, is_bare, paused, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id, github_owner, github_repo, local_path, is_bare, paused, issues_reconciled_at`,
            [
              id,
              githubOwner,
              githubRepo,
              localPath,
              input.isBare,
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

        const row = result[0] as
          | {
              id: string
              github_owner: string
              github_repo: string
              local_path: string
              is_bare: boolean | number
              paused: boolean | number
              issues_reconciled_at: number | null
            }
          | undefined
        if (!row) {
          return yield* new DatabaseError({
            message: "No repository returned from insert",
          })
        }

        const repository = toRecord({
          id: row.id,
          githubOwner: row.github_owner,
          githubRepo: row.github_repo,
          localPath: row.local_path,
          isBare: row.is_bare,
          paused: row.paused,
          issuesReconciledAt: row.issues_reconciled_at,
        })
        yield* PubSub.publish(repositoryChanges, undefined)
        return repository
      })

    const listRepositories: Effect.Effect<
      readonly RepositoryRecord[],
      DatabaseError
    > = Effect.gen(function* () {
      const repositories = yield* sql
        .unsafe(
          `SELECT id, github_owner, github_repo, local_path, is_bare, paused,
             issues_reconciled_at
           FROM repository
           ORDER BY lower(github_owner) ASC, lower(github_repo) ASC`,
        )
        .pipe(Effect.mapError(toDatabaseError))

      return (
        repositories as ReadonlyArray<{
          id: string
          github_owner: string
          github_repo: string
          local_path: string
          is_bare: boolean | number
          paused: boolean | number
          issues_reconciled_at: number | null
        }>
      ).map((row) =>
        toRecord({
          id: row.id,
          githubOwner: row.github_owner,
          githubRepo: row.github_repo,
          localPath: row.local_path,
          isBare: row.is_bare,
          paused: row.paused,
          issuesReconciledAt: row.issues_reconciled_at,
        }),
      )
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
    ): Effect.Effect<void, RepositoryNotFoundError | DatabaseError> =>
      Effect.gen(function* () {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
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
              error instanceof RepositoryNotFoundError
                ? error
                : toDatabaseError(error),
            ),
          )
        yield* PubSub.publish(repositoryChanges, undefined)
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
                parent_github_issue_url, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repository_id, github_issue_number) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               url = excluded.url,
                state = excluded.state,
                github_created_at = excluded.github_created_at,
                parent_github_issue_number = excluded.parent_github_issue_number,
                parent_github_issue_url = excluded.parent_github_issue_url,
                updated_at = excluded.updated_at
              RETURNING id, repository_id, github_issue_number, title, body, url, state,
                github_created_at, parent_github_issue_number,
                parent_github_issue_url`,
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
                parent_github_issue_url
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
            blockedBy: dependenciesByIssue.get(issue.id) ?? [],
          }),
        )
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

    return DbService.of({
      repositoryChanges: Stream.fromPubSub(repositoryChanges),
      getConfig,
      updateConfig,
      addRepository,
      listRepositories,
      removeRepository,
      storeIssue,
      listIssues,
      deleteIssue,
      markIssuesReconciled,
    })
  }),
)
