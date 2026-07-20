import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Config, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { embeddedMigrationSources } from "./embedded-migrations.gen.js"

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

const MigrationAppliedRow = Schema.Struct({
  hash: Schema.String,
})

export type MigrationSource = {
  readonly name: string
  readonly sql: string
}

type MigrationRecord = {
  readonly hash: string
  readonly name: string
  readonly folderMillis: number
  readonly statements: ReadonlyArray<string>
}

export class MigrationReadError extends Schema.TaggedErrorClass<MigrationReadError>()(
  "MigrationReadError",
  { cause: Schema.Defect() },
) {}

const toMigrationRecords = (
  sources: ReadonlyArray<MigrationSource>,
): ReadonlyArray<MigrationRecord> =>
  sources
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((source) => ({
      hash: createHash("sha256").update(source.sql).digest("hex"),
      name: source.name,
      folderMillis: Number(source.name.slice(0, 14)),
      statements: source.sql.split("--> statement-breakpoint"),
    }))

const readMigrationSourcesFromFolder = (migrationsFolder: string) =>
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
            return { name: entry.name, sql }
          }),
      )
    },
    catch: (cause) => new MigrationReadError({ cause }),
  })

const applyMigrationRecords = Effect.fn("applyMigrationRecords")(function* (
  migrations: ReadonlyArray<MigrationRecord>,
) {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )
  `

  const appliedRows = yield* sql`SELECT hash FROM __drizzle_migrations`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Array(MigrationAppliedRow)),
    ),
  )
  const appliedHashes = new Set(appliedRows.map((row) => row.hash))

  for (const migration of migrations) {
    if (appliedHashes.has(migration.hash)) {
      continue
    }

    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const query of migration.statements) {
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
 * Apply Drizzle migration SQL sources via the current SqlClient.
 * Skips migrations already recorded in __drizzle_migrations.
 */
export const runMigrationsFromSources = Effect.fn("runMigrationsFromSources")(
  function* (sources: ReadonlyArray<MigrationSource>) {
    yield* applyMigrationRecords(toMigrationRecords(sources))
  },
)

/**
 * Apply Drizzle migration SQL files via the current SqlClient.
 * Skips migrations already recorded in __drizzle_migrations.
 */
export const runMigrations = Effect.fn("runMigrations")(function* (
  migrationsFolder: string,
) {
  const sources = yield* readMigrationSourcesFromFolder(migrationsFolder)
  yield* runMigrationsFromSources(sources)
})

/**
 * Run migrations using embedded SQL when present, otherwise MIGRATIONS_FOLDER
 * (defaults to db-schema/drizzle on disk).
 */
export const runConfiguredMigrations = Effect.fn("runConfiguredMigrations")(
  function* () {
    if (embeddedMigrationSources.length > 0) {
      yield* runMigrationsFromSources(embeddedMigrationSources)
      return
    }
    const migrationsFolder = yield* MigrationsFolderConfig
    yield* runMigrations(migrationsFolder)
  },
)
