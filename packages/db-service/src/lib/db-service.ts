import type { SqlError } from "@effect/sql/SqlError"
import { and, asc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { ulid } from "ulidx"
import { TypedSqliteDrizzle, runDrizzle } from "@ready-for-agent/db"
import * as schema from "@ready-for-agent/db-schema"
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
  isBare: boolean
  paused: boolean
}): RepositoryRecord => ({
  id: row.id,
  githubOwner: row.githubOwner,
  githubRepo: row.githubRepo,
  localPath: row.localPath,
  isBare: row.isBare,
  paused: row.paused,
})

const toIssueRecord = (row: {
  id: string
  repositoryId: string
  githubIssueNumber: number
  title: string
  githubCreatedAt: number
}): IssueRecord => ({
  id: row.id,
  repositoryId: row.repositoryId,
  githubIssueNumber: row.githubIssueNumber,
  title: row.title,
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
}

export class DbService extends Context.Tag(
  "@ready-for-agent/db-service/DbService",
)<DbService, DbServiceShape>() {}

export const DbServiceLive = Layer.effect(
  DbService,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

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

        const existingByGithub = yield* runDrizzle(
          db
            .select({ id: schema.repository.id })
            .from(schema.repository)
            .where(
              and(
                sql`lower(${schema.repository.githubOwner}) = ${githubOwner.toLowerCase()}`,
                sql`lower(${schema.repository.githubRepo}) = ${githubRepo.toLowerCase()}`,
              ),
            )
            .limit(1),
        ).pipe(Effect.mapError(toDatabaseError))

        if (existingByGithub[0]) {
          return yield* new RepositoryAlreadyExistsError({
            githubOwner,
            githubRepo,
          })
        }

        const existingByPath = yield* runDrizzle(
          db
            .select({ id: schema.repository.id })
            .from(schema.repository)
            .where(eq(schema.repository.localPath, localPath))
            .limit(1),
        ).pipe(Effect.mapError(toDatabaseError))

        if (existingByPath[0]) {
          return yield* new LocalPathInUseError({ localPath })
        }

        const result = yield* runDrizzle(
          db
            .insert(schema.repository)
            .values({
              id,
              githubOwner,
              githubRepo,
              localPath,
              isBare: input.isBare,
              paused: true,
              createdAt: now,
              updatedAt: now,
            })
            .returning({
              id: schema.repository.id,
              githubOwner: schema.repository.githubOwner,
              githubRepo: schema.repository.githubRepo,
              localPath: schema.repository.localPath,
              isBare: schema.repository.isBare,
              paused: schema.repository.paused,
            }),
        ).pipe(
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

        const row = result[0]
        if (!row) {
          return yield* new DatabaseError({
            message: "No repository returned from insert",
          })
        }

        return toRecord(row)
      })

    const ensureRepositoryExists = (
      repositoryId: string,
    ): Effect.Effect<void, RepositoryNotFoundError | DatabaseError> =>
      Effect.gen(function* () {
        const repository = yield* runDrizzle(
          db
            .select({ id: schema.repository.id })
            .from(schema.repository)
            .where(eq(schema.repository.id, repositoryId))
            .limit(1),
        ).pipe(Effect.mapError(toDatabaseError))

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
        if (Number.isNaN(input.githubCreatedAt.getTime())) {
          return yield* new InvalidIssueInputError({
            field: "githubCreatedAt",
            message: "githubCreatedAt must be a valid date",
          })
        }

        yield* ensureRepositoryExists(input.repositoryId)

        const now = Date.now()
        const result = yield* runDrizzle(
          db
            .insert(schema.issue)
            .values({
              id: `issue-${ulid()}`,
              repositoryId: input.repositoryId,
              githubIssueNumber: input.githubIssueNumber,
              title: input.title,
              githubCreatedAt: input.githubCreatedAt.getTime(),
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                schema.issue.repositoryId,
                schema.issue.githubIssueNumber,
              ],
              set: {
                title: input.title,
                githubCreatedAt: input.githubCreatedAt.getTime(),
                updatedAt: now,
              },
            })
            .returning({
              id: schema.issue.id,
              repositoryId: schema.issue.repositoryId,
              githubIssueNumber: schema.issue.githubIssueNumber,
              title: schema.issue.title,
              githubCreatedAt: schema.issue.githubCreatedAt,
            }),
        ).pipe(Effect.mapError(toDatabaseError))

        const row = result[0]
        if (!row) {
          return yield* new DatabaseError({
            message: "No issue returned from upsert",
          })
        }

        return toIssueRecord(row)
      })

    const listIssues = (
      repositoryId: string,
    ): Effect.Effect<
      readonly IssueRecord[],
      RepositoryNotFoundError | DatabaseError
    > =>
      Effect.gen(function* () {
        yield* ensureRepositoryExists(repositoryId)

        const issues = yield* runDrizzle(
          db
            .select({
              id: schema.issue.id,
              repositoryId: schema.issue.repositoryId,
              githubIssueNumber: schema.issue.githubIssueNumber,
              title: schema.issue.title,
              githubCreatedAt: schema.issue.githubCreatedAt,
            })
            .from(schema.issue)
            .where(eq(schema.issue.repositoryId, repositoryId))
            .orderBy(asc(schema.issue.githubIssueNumber)),
        ).pipe(Effect.mapError(toDatabaseError))

        return issues.map(toIssueRecord)
      })

    return DbService.of({ addRepository, storeIssue, listIssues })
  }),
)
