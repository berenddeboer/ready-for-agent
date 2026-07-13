import type { SqlError } from "@effect/sql/SqlError"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { ulid } from "ulidx"
import { TypedSqliteDrizzle, runDrizzle } from "@ready-for-agent/db"
import * as schema from "@ready-for-agent/db-schema"
import {
  DatabaseError,
  InvalidRepositoryInputError,
  LocalPathInUseError,
  RepositoryAlreadyExistsError,
} from "./errors.js"
import type { AddRepositoryInput, RepositoryRecord } from "./types.js"

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

    return DbService.of({ addRepository })
  }),
)
