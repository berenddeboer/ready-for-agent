import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Config, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const defaultMigrationsFolder = join(
  __dirname,
  "../../../db-schema/drizzle",
)

/**
 * Config for the migrations folder path.
 * Override with ConfigProvider.fromMap({ MIGRATIONS_FOLDER: "/custom/path" })
 */
export const MigrationsFolderConfig = Config.string("MIGRATIONS_FOLDER").pipe(
  Config.withDefault(defaultMigrationsFolder),
)

const rawSql = (query: string) => Object.assign([query], { raw: [query] })

type MigrationRow = {
  readonly hash: string
}

export class MigrationReadError extends Schema.TaggedErrorClass<MigrationReadError>()(
  "MigrationReadError",
  { cause: Schema.Defect() },
) {}

const readMigrations = (migrationsFolder: string) =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir(migrationsFolder, { withFileTypes: true })
      return Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(async (entry) => {
            const sql = await readFile(
              join(migrationsFolder, entry.name, "migration.sql"),
              "utf8",
            )
            return {
              hash: createHash("sha256").update(sql).digest("hex"),
              name: entry.name,
              folderMillis: Number(entry.name.slice(0, 14)),
              sql: sql.split("--> statement-breakpoint"),
            }
          }),
      )
    },
    catch: (cause) => new MigrationReadError({ cause }),
  })

/**
 * Apply Drizzle migration SQL files via the current SqlClient.
 * Skips migrations already recorded in __drizzle_migrations.
 */
export const runMigrations = (migrationsFolder: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const migrations = yield* readMigrations(migrationsFolder)

    yield* sql`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `

    const appliedRows = (yield* sql`
      SELECT hash FROM __drizzle_migrations
    `) as ReadonlyArray<MigrationRow>
    const appliedHashes = new Set(appliedRows.map((row) => row.hash))

    for (const migration of migrations) {
      if (appliedHashes.has(migration.hash)) {
        continue
      }

      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const query of migration.sql) {
            if (query.trim().length > 0) {
              yield* sql(rawSql(query))
            }
          }

          yield* sql`
            INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
            VALUES (
              ${migration.hash},
              ${migration.folderMillis},
              ${migration.name},
              ${new Date().toISOString()}
            )
          `
        }),
      )
    }
  })

/**
 * Run migrations using MIGRATIONS_FOLDER config (defaults to db-schema/drizzle).
 */
export const runConfiguredMigrations = Effect.gen(function* () {
  const migrationsFolder = yield* MigrationsFolderConfig
  yield* runMigrations(migrationsFolder)
})
