import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { ulid } from "ulidx"
import {
  DatabaseError,
  InvalidIssueInputError,
  InvalidRepositoryInputError,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
  RepositoryNotFoundError,
} from "./errors.js"
import type {
  AddRepositoryInput,
  IssueRecord,
  RepositoryRecord,
  StoreIssueInput,
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
}): IssueRecord => ({
  id: row.id,
  repositoryId: row.repositoryId,
  githubIssueNumber: row.githubIssueNumber,
  title: row.title,
  body: row.body,
  url: row.url,
  state: row.state,
  githubCreatedAt: new Date(row.githubCreatedAt),
})

const toDatabaseError = (error: SqlError) =>
  new DatabaseError({
    message: `Database error: ${formatSqlError(error)}`,
    cause: error,
  })

export interface DbServiceShape {
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

        return toRecord({
          id: row.id,
          githubOwner: row.github_owner,
          githubRepo: row.github_repo,
          localPath: row.local_path,
          isBare: row.is_bare,
          paused: row.paused,
          issuesReconciledAt: row.issues_reconciled_at,
        })
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

        yield* ensureRepositoryExists(input.repositoryId)

        const now = Date.now()
        const result = yield* sql
          .unsafe(
            `INSERT INTO issue (
               id, repository_id, github_issue_number, title, body, url, state,
               github_created_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (repository_id, github_issue_number) DO UPDATE SET
               title = excluded.title,
               body = excluded.body,
               url = excluded.url,
               state = excluded.state,
               github_created_at = excluded.github_created_at,
               updated_at = excluded.updated_at
             RETURNING id, repository_id, github_issue_number, title, body, url, state,
               github_created_at`,
            [
              `issue-${ulid()}`,
              input.repositoryId,
              input.githubIssueNumber,
              input.title,
              input.body,
              input.url,
              input.state,
              input.githubCreatedAt.getTime(),
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
            }
          | undefined
        if (!row) {
          return yield* new DatabaseError({
            message: "No issue returned from upsert",
          })
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
        })
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
               github_created_at
             FROM issue WHERE repository_id = ? ORDER BY github_issue_number ASC`,
            [repositoryId],
          )
          .pipe(Effect.mapError(toDatabaseError))

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
      addRepository,
      listRepositories,
      storeIssue,
      listIssues,
      deleteIssue,
      markIssuesReconciled,
    })
  }),
)
