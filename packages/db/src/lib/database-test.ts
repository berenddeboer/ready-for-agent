import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  MigrationsFolderConfig,
  defaultMigrationsFolder,
  runMigrations,
} from "./run-migrations.js"

export { MigrationsFolderConfig, defaultMigrationsFolder }

/**
 * In-memory SQLite client for tests, with foreign keys enabled on startup.
 */
export const SqliteTest = Layer.provideMerge(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`PRAGMA foreign_keys = ON`
    }),
  ),
  SqliteClient.layer({
    filename: ":memory:",
  }),
)

const MigrationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const migrationsFolder = yield* MigrationsFolderConfig
    yield* runMigrations(migrationsFolder)
  }),
)

/**
 * Full test database layer: in-memory SQLite + migrations.
 * Default consumer path for tests; production uses {@link DatabaseLive}.
 */
export const DatabaseTest = MigrationLayer.pipe(Layer.provideMerge(SqliteTest))
