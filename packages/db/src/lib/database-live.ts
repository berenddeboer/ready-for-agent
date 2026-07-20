import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  DatabasePathConfig,
  normalizeDatabasePath,
  toTursoDatabasePath,
} from "@ready-for-agent/layer-turso-local/database-path"

export class DatabaseDirectoryError extends Schema.TaggedErrorClass<DatabaseDirectoryError>()(
  "DatabaseDirectoryError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const ensureLocalDatabaseParentDir = (path: string) =>
  path === ":memory:"
    ? Effect.void
    : Effect.try({
        try: () => {
          mkdirSync(dirname(path), { recursive: true })
        },
        catch: (cause) =>
          new DatabaseDirectoryError({ path: dirname(path), cause }),
      })

/**
 * Production database layer for the harness: Bun-native SQLite
 * (`@effect/sql-sqlite-bun`) plus path resolution from
 * `@ready-for-agent/layer-turso-local` (`SQLITE_DATABASE_PATH` /
 * product data-dir).
 *
 * Prefer this for host binaries and the default app stack
 * (`DbServiceLive.pipe(Layer.provideMerge(DatabaseLive))`).
 *
 * For a Turso SDK `SqlClient` instead, compose
 * `@ready-for-agent/layer-turso-local`'s `makeTursoLive` /
 * `TursoLive` — same path config, different driver.
 */
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const configured = yield* DatabasePathConfig
    const filename = toTursoDatabasePath(normalizeDatabasePath(configured))
    yield* ensureLocalDatabaseParentDir(filename)
    const client = SqliteClient.layer({
      filename,
      create: true,
      readwrite: true,
    })
    const foreignKeys = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
      }),
    )
    return Layer.provideMerge(foreignKeys, client)
  }),
)
