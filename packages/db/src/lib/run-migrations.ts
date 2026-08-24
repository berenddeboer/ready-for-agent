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

// These migrations were replaced by 20260718055957_baseline in 231baf1.
// Upgraded databases retain their history rows after adopting the baseline.
const retiredMigrationHashes = new Set([
  "9cf413f08da24870cea628db84ef7260bf371f9e349483c5ec6e11cae29f506c",
  "b3c2d0ed339f767e772183805b721ab41674e4220ec9970a0fd10e6ca9ff68eb",
  "8890a0238e7b86bc833eb538c5fcabbc60a92f2ff182767a757282f1d6830d54",
  "d109933eb76c32d05a415d3e744d6832501a7f4e4e511c2fe30b17c7189d58bc",
  "9f09a945bc35786056731e5f54af266f68357d3814a5d61aae9208553d47dfca",
  "20ecdcdbe2bde5195c72b3765d8df0b55e59a12b190576c4ef931584b40be341",
  "de37925c66885dc2d862079ee2f7c52a8e4b8eda62902d9dcc738d494d6713cd",
  "dfc8738cdf804eb14af424a40c634087d9b1ba657b54c885f87bb352c5da2efa",
  "712789515f0e41c8da6d58de327d5740c90cd25055dbe5af99f29a4b1c205db8",
  "bf8529a5918695ec851b289700cc6779bfd09195ec8841be267953718d5529a7",
  "7ad0cdd3c4151dc83dece6582128a54b10b0059357d3644529e7d994a10f1a0e",
  "81b1c8ca4d6fe6ed24d3e7b01c3d85f86fb753d0dc3941015f65dc23ade671c2",
  "3cab5c243043427e0ecfa57fa381760dea543dd388e5f32bab8232afe3344f16",
  "e8490e9260a06e3ccf2d502a7b90784095170310c8021abe761698f9366e8e04",
  "6df2779aca329fb59eaef9b3de5ede0ad821d59307abf32176a2f78356f057ee",
  "21566482629a4c2b2d1257a81670732c83f5198b413c9444841fc860f4c013d0",
  "13e83a871ea626600c1878751edf5d83f2ae1b4d5ef6497670d59f69d3061d25",
  "1e11e01a9c7649acaf848eb7c6856a96938b85b26fc69fbb62b2b649361d9ef3",
  "0f745571e11f1d7cf3ac2652c9cdf3f4f37a36a0e07e7a523632949e9b02fb40",
  "c4f1e1ec693197ce15d37d6c83a2b5c7872e7ed00363eaa279c3628c1d38aef9",
  "86ab6fc540a7d87c7325c1b74fbf666f55d47ee50aa7643bd00488ff576c81f3",
  "0c34034cea56f31e303e2c41c7f3a8dc85cc986282ae5d23e3308660b50ca1db",
  "fb21bd4e53d06811dac158267cdc43b307d6e49137e186a24205ce369661007e",
])

const MigrationAppliedRow = Schema.Struct({
  hash: Schema.String,
  name: Schema.NullOr(Schema.String),
})

export type MigrationSource = {
  readonly name: string
  readonly sql: string
}

/** A migration that was newly applied in this run (not already in __drizzle_migrations). */
export type AppliedMigration = {
  readonly name: string
  readonly hash: string
}

/** Outcome of a migration run: which migrations were applied this time. */
export type MigrationRunResult = {
  readonly applied: ReadonlyArray<AppliedMigration>
}

type MigrationRecord = {
  readonly hash: string
  readonly name: string
  readonly folderMillis: number
  readonly statements: ReadonlyArray<string>
}

/**
 * User-facing success line when migrations actually ran.
 * Returns null when nothing was applied (startup should stay quiet).
 */
export const migrationsAppliedLogMessage = (
  result: MigrationRunResult,
): string | null => {
  const count = result.applied.length
  if (count === 0) {
    return null
  }
  return count === 1
    ? "Applied 1 database migration"
    : `Applied ${count} database migrations`
}

/** Log only when at least one migration was applied. */
export const logMigrationsAppliedIfAny = (result: MigrationRunResult): void => {
  const message = migrationsAppliedLogMessage(result)
  if (message !== null) {
    console.info(message)
  }
}

export class MigrationReadError extends Schema.TaggedErrorClass<MigrationReadError>()(
  "MigrationReadError",
  { cause: Schema.Defect() },
) {}

/** Singular/plural "N migration(s)" phrasing, matching {@link migrationsAppliedLogMessage}. */
const pluralizeMigrationCount = (count: number): string =>
  count === 1 ? "1 migration" : `${count} migrations`

/**
 * The database has migrations recorded in `__drizzle_migrations` that this
 * binary's embedded/on-disk migration set does not know about — i.e. the
 * running binary is *older* than the database it is pointed at (see
 * ready-for-agent#18/#21). Continuing would otherwise re-run the same failing
 * queries against a schema this binary doesn't understand, forever.
 */
export class StaleBinaryMigrationError extends Schema.TaggedErrorClass<StaleBinaryMigrationError>()(
  "StaleBinaryMigrationError",
  {
    /** Names (or hashes, if unnamed) of DB migrations this binary doesn't recognize. */
    unrecognizedMigrationNames: Schema.Array(Schema.String),
    /** How many migrations this binary's embedded/on-disk set knows about. */
    knownMigrationCount: Schema.Finite,
  },
) {
  override get message() {
    const names = this.unrecognizedMigrationNames.join(", ")
    const unrecognizedCount = pluralizeMigrationCount(
      this.unrecognizedMigrationNames.length,
    )
    const knownCount = pluralizeMigrationCount(this.knownMigrationCount)
    return (
      `This build of ready-for-agent is older than the database it is pointed at: ` +
      `the database has ${unrecognizedCount} this binary does not recognize (${names}), ` +
      `but this binary only knows about ${knownCount}. ` +
      `Upgrade or reinstall ready-for-agent to a version built after those migrations, ` +
      `or point it at a fresh database (e.g. set SQLITE_DATABASE_PATH to a new file).`
    )
  }
}

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

  const appliedRows =
    yield* sql`SELECT hash, name FROM __drizzle_migrations`.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(MigrationAppliedRow)),
      ),
    )
  const appliedHashes = new Set(appliedRows.map((row) => row.hash))

  // Fail fast, before applying anything, if the database was migrated by a
  // build that knows about migrations this binary's embedded/on-disk set
  // doesn't (stale binary vs. newer database).
  const knownHashes = new Set(migrations.map((migration) => migration.hash))
  const unrecognizedRows = appliedRows.filter(
    (row) =>
      !knownHashes.has(row.hash) && !retiredMigrationHashes.has(row.hash),
  )
  if (unrecognizedRows.length > 0) {
    return yield* new StaleBinaryMigrationError({
      unrecognizedMigrationNames: unrecognizedRows.map(
        (row) => row.name ?? row.hash,
      ),
      knownMigrationCount: migrations.length,
    })
  }

  const newlyApplied: Array<AppliedMigration> = []

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
    newlyApplied.push({ name: migration.name, hash: migration.hash })
  }

  return { applied: newlyApplied } satisfies MigrationRunResult
})

/**
 * Apply Drizzle migration SQL sources via the current SqlClient.
 * Skips migrations already recorded in __drizzle_migrations.
 * Returns which migrations were newly applied in this run.
 */
export const runMigrationsFromSources = Effect.fn("runMigrationsFromSources")(
  function* (sources: ReadonlyArray<MigrationSource>) {
    return yield* applyMigrationRecords(toMigrationRecords(sources))
  },
)

/**
 * Apply Drizzle migration SQL files via the current SqlClient.
 * Skips migrations already recorded in __drizzle_migrations.
 * Returns which migrations were newly applied in this run.
 */
export const runMigrations = Effect.fn("runMigrations")(function* (
  migrationsFolder: string,
) {
  const sources = yield* readMigrationSourcesFromFolder(migrationsFolder)
  return yield* runMigrationsFromSources(sources)
})

/**
 * Run migrations using embedded SQL when present, otherwise MIGRATIONS_FOLDER
 * (defaults to db-schema/drizzle on disk).
 * Returns which migrations were newly applied in this run.
 */
export const runConfiguredMigrations = Effect.fn("runConfiguredMigrations")(
  function* () {
    if (embeddedMigrationSources.length > 0) {
      return yield* runMigrationsFromSources(embeddedMigrationSources)
    }
    const migrationsFolder = yield* MigrationsFolderConfig
    return yield* runMigrations(migrationsFolder)
  },
)
