import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  DatabasePathConfig,
  normalizeDatabasePath,
  toTursoDatabasePath,
} from "@ready-for-agent/layer-turso-local/database-path"

const ensureLocalDatabaseParentDir = (path: string) => {
  if (path === ":memory:") return
  mkdirSync(dirname(path), { recursive: true })
}

/**
 * Production database layer: Bun-native SQLite (works inside compiled host binaries)
 * + SQLITE_DATABASE_PATH / product data-dir resolution from layer-turso-local.
 */
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const configured = yield* DatabasePathConfig
    const filename = toTursoDatabasePath(normalizeDatabasePath(configured))
    ensureLocalDatabaseParentDir(filename)
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
