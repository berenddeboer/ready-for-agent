import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Config, Context, Effect, Layer } from "effect"
import { runSqliteTestMigrations } from "./test-migrations.js"
import { TypedSqliteDrizzleLayer } from "./typed-drizzle.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const defaultMigrationsFolder = join(__dirname, "../../../db-schema/drizzle")

/**
 * Config for the migrations folder path.
 * Override with ConfigProvider.fromMap({ MIGRATIONS_FOLDER: "/custom/path" })
 */
export const MigrationsFolderConfig = Config.string("MIGRATIONS_FOLDER").pipe(
  Config.withDefault(defaultMigrationsFolder),
)

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
