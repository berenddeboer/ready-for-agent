import { SqliteClient } from "@effect/sql-sqlite-bun"
import { type Config, Effect, Layer } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  type MigrationReadError,
  MigrationsFolderConfig,
  defaultMigrationsFolder,
  runMigrations,
} from "./run-migrations.js"

export { MigrationsFolderConfig, defaultMigrationsFolder }

/**
 * In-memory SQLite client for tests.
 */
export const SqliteTest = SqliteClient.layer({
  filename: ":memory:",
})

const MigrationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const migrationsFolder = yield* MigrationsFolderConfig
    yield* runMigrations(migrationsFolder)
  }),
)

/**
 * Full test database layer: in-memory SQLite + migrations + typed Drizzle.
 */
export const DatabaseTest: Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient,
  Config.ConfigError | MigrationReadError | SqlError
> = Layer.merge(
  SqliteTest,
  MigrationLayer.pipe(Layer.provide(SqliteTest)),
) as unknown as Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient,
  Config.ConfigError | MigrationReadError | SqlError
>
