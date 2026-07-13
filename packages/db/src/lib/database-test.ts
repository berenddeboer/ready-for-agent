import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Context, Effect, Layer } from "effect"
import {
  MigrationsFolderConfig,
  defaultMigrationsFolder,
} from "./run-migrations.js"
import { runSqliteTestMigrations } from "./test-migrations.js"
import { TypedSqliteDrizzleLayer } from "./typed-drizzle.js"

export { MigrationsFolderConfig, defaultMigrationsFolder }

const runPragmas = (ctx: Context.Context<SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const sql = Context.get(ctx, SqlClient.SqlClient)
    yield* sql`PRAGMA foreign_keys = ON`
  })

/**
 * In-memory SQLite client for tests.
 */
export const SqliteTest = SqliteClient.layer({
  filename: ":memory:",
}).pipe(Layer.tap(runPragmas))

const DrizzleTest = TypedSqliteDrizzleLayer.pipe(Layer.provide(SqliteTest))

const MigrationLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const migrationsFolder = yield* MigrationsFolderConfig
    yield* runSqliteTestMigrations(migrationsFolder)
  }),
)

/**
 * Full test database layer: in-memory SQLite + migrations + typed Drizzle.
 */
export const DatabaseTest = MigrationLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(SqliteTest, DrizzleTest)),
)
