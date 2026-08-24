import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteTest } from "../src/lib/database-test.js"
import {
  defaultMigrationsFolder,
  migrationsAppliedLogMessage,
  runMigrations,
  runMigrationsFromSources,
} from "../src/lib/run-migrations.js"
import { afterEach, describe, expect, it } from "bun:test"

const temporaryDirectories: Array<string> = []

const preSquashMigrations = [
  [
    "20260712233736_harsh_sunspot",
    "9cf413f08da24870cea628db84ef7260bf371f9e349483c5ec6e11cae29f506c",
  ],
  [
    "20260713001702_conscious_maggott",
    "b3c2d0ed339f767e772183805b721ab41674e4220ec9970a0fd10e6ca9ff68eb",
  ],
  [
    "20260713055248_youthful_toxin",
    "8890a0238e7b86bc833eb538c5fcabbc60a92f2ff182767a757282f1d6830d54",
  ],
  [
    "20260713073802_parallel_shiver_man",
    "d109933eb76c32d05a415d3e744d6832501a7f4e4e511c2fe30b17c7189d58bc",
  ],
  [
    "20260713093925_dear_mother_askani",
    "9f09a945bc35786056731e5f54af266f68357d3814a5d61aae9208553d47dfca",
  ],
  [
    "20260713095502_bitter_slayback",
    "20ecdcdbe2bde5195c72b3765d8df0b55e59a12b190576c4ef931584b40be341",
  ],
  [
    "20260713215850_opposite_the_enforcers",
    "de37925c66885dc2d862079ee2f7c52a8e4b8eda62902d9dcc738d494d6713cd",
  ],
  [
    "20260714011733_hard_umar",
    "dfc8738cdf804eb14af424a40c634087d9b1ba657b54c885f87bb352c5da2efa",
  ],
  [
    "20260714015155_military_goblin_queen",
    "712789515f0e41c8da6d58de327d5740c90cd25055dbe5af99f29a4b1c205db8",
  ],
  [
    "20260714041109_luxuriant_selene",
    "bf8529a5918695ec851b289700cc6779bfd09195ec8841be267953718d5529a7",
  ],
  [
    "20260714234648_cynical_hairball",
    "7ad0cdd3c4151dc83dece6582128a54b10b0059357d3644529e7d994a10f1a0e",
  ],
  [
    "20260715034956_familiar_randall_flagg",
    "81b1c8ca4d6fe6ed24d3e7b01c3d85f86fb753d0dc3941015f65dc23ade671c2",
  ],
  [
    "20260715212153_lame_celestials",
    "3cab5c243043427e0ecfa57fa381760dea543dd388e5f32bab8232afe3344f16",
  ],
  [
    "20260715224622_cheerful_the_phantom",
    "e8490e9260a06e3ccf2d502a7b90784095170310c8021abe761698f9366e8e04",
  ],
  [
    "20260715233120_busy_owl",
    "6df2779aca329fb59eaef9b3de5ede0ad821d59307abf32176a2f78356f057ee",
  ],
  [
    "20260716055050_abandoned_luminals",
    "21566482629a4c2b2d1257a81670732c83f5198b413c9444841fc860f4c013d0",
  ],
  [
    "20260716065104_uneven_wallow",
    "13e83a871ea626600c1878751edf5d83f2ae1b4d5ef6497670d59f69d3061d25",
  ],
  [
    "20260716214425_simple_gideon",
    "1e11e01a9c7649acaf848eb7c6856a96938b85b26fc69fbb62b2b649361d9ef3",
  ],
  [
    "20260717120000_needs_human_unfinished",
    "0f745571e11f1d7cf3ac2652c9cdf3f4f37a36a0e07e7a523632949e9b02fb40",
  ],
  [
    "20260717180000_max_concurrent_opencode_sessions",
    "c4f1e1ec693197ce15d37d6c83a2b5c7872e7ed00363eaa279c3628c1d38aef9",
  ],
  [
    "20260717190000_max_concurrent_work_items",
    "86ab6fc540a7d87c7325c1b74fbf666f55d47ee50aa7643bd00488ff576c81f3",
  ],
  [
    "20260718120000_nullable_config_build_model",
    "0c34034cea56f31e303e2c41c7f3a8dc85cc986282ae5d23e3308660b50ca1db",
  ],
  [
    "20260718140000_assess_changes_starting_commit",
    "fb21bd4e53d06811dac158267cdc43b307d6e49137e186a24205ce369661007e",
  ],
] as const

const migrationFolder = async (name: string, migrationSql: string) => {
  const root = await mkdtemp(join(tmpdir(), "db-migrations-"))
  temporaryDirectories.push(root)
  const folder = join(root, name)
  await mkdir(folder)
  await writeFile(join(folder, "migration.sql"), migrationSql)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("migrationsAppliedLogMessage", () => {
  it("returns null when no migrations were applied", () => {
    expect(migrationsAppliedLogMessage({ applied: [] })).toBeNull()
  })

  it("describes a single applied migration", () => {
    expect(
      migrationsAppliedLogMessage({
        applied: [{ name: "20260101000000_one", hash: "abc" }],
      }),
    ).toBe("Applied 1 database migration")
  })

  it("describes multiple applied migrations with a count", () => {
    expect(
      migrationsAppliedLogMessage({
        applied: [
          { name: "20260101000000_one", hash: "abc" },
          { name: "20260102000000_two", hash: "def" },
        ],
      }),
    ).toBe("Applied 2 database migrations")
  })
})

describe("runMigrations", () => {
  it("returns newly applied migrations and nothing on a second run", async () => {
    const firstSql = "CREATE TABLE first_table (id integer);"
    const secondSql = "CREATE TABLE second_table (id integer);"
    const folder = await migrationFolder("20260101000000_first", firstSql)
    const secondFolder = join(folder, "20260102000000_second")
    await mkdir(secondFolder)
    await writeFile(join(secondFolder, "migration.sql"), secondSql)

    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* runMigrations(folder)
        expect(first.applied).toEqual([
          {
            name: "20260101000000_first",
            hash: createHash("sha256").update(firstSql).digest("hex"),
          },
          {
            name: "20260102000000_second",
            hash: createHash("sha256").update(secondSql).digest("hex"),
          },
        ])
        expect(migrationsAppliedLogMessage(first)).toBe(
          "Applied 2 database migrations",
        )

        const second = yield* runMigrations(folder)
        expect(second.applied).toEqual([])
        expect(migrationsAppliedLogMessage(second)).toBeNull()
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("returns only migrations that were not already recorded", async () => {
    const existingSql = "CREATE TABLE already_there (id integer);"
    const pendingSql = "CREATE TABLE newly_there (id integer);"
    const existingHash = createHash("sha256").update(existingSql).digest("hex")
    const pendingHash = createHash("sha256").update(pendingSql).digest("hex")

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          CREATE TABLE __drizzle_migrations (
            id INTEGER PRIMARY KEY,
            hash text NOT NULL,
            created_at numeric,
            name text,
            applied_at TEXT
          )
        `
        yield* sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES (
            ${existingHash},
            ${20260101000000},
            ${"20260101000000_existing"},
            ${"2026-01-01T00:00:00.000Z"}
          )
        `

        const result = yield* runMigrationsFromSources([
          { name: "20260101000000_existing", sql: existingSql },
          { name: "20260102000000_pending", sql: pendingSql },
        ])

        expect(result.applied).toEqual([
          { name: "20260102000000_pending", hash: pendingHash },
        ])
        expect(migrationsAppliedLogMessage(result)).toBe(
          "Applied 1 database migration",
        )

        const tables = yield* sql`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('already_there', 'newly_there')
          ORDER BY name
        `
        // existing was skipped (hash already recorded), so only pending ran
        expect(tables).toEqual([{ name: "newly_there" }])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("fails fast when the database has migrations this binary doesn't recognize", async () => {
    // Simulates a stale binary: the DB (migrated by a newer build) has two
    // recorded migrations, but this binary's embedded/on-disk set only knows
    // about the first one (a strict subset of what's recorded).
    const knownSql = "CREATE TABLE known_table (id integer);"
    const knownHash = createHash("sha256").update(knownSql).digest("hex")
    const unknownSql = "CREATE TABLE unrecognized_table (id integer);"
    const unknownHash = createHash("sha256").update(unknownSql).digest("hex")

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          CREATE TABLE __drizzle_migrations (
            id INTEGER PRIMARY KEY,
            hash text NOT NULL,
            created_at numeric,
            name text,
            applied_at TEXT
          )
        `
        yield* sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES
            (${knownHash}, ${20260101000000}, ${"20260101000000_known"}, ${"2026-01-01T00:00:00.000Z"}),
            (${unknownHash}, ${20260102000000}, ${"20260102000000_unrecognized"}, ${"2026-01-02T00:00:00.000Z"})
        `

        const error = yield* runMigrationsFromSources([
          { name: "20260101000000_known", sql: knownSql },
        ]).pipe(Effect.flip)

        expect(error._tag).toBe("StaleBinaryMigrationError")
        expect(error.unrecognizedMigrationNames).toEqual([
          "20260102000000_unrecognized",
        ])
        expect(error.knownMigrationCount).toBe(1)
        expect(error.message).toContain(
          "This build of ready-for-agent is older than the database",
        )
        expect(error.message).toContain("20260102000000_unrecognized")
        // Singular counts read "1 migration", not "1 migration(s)".
        expect(error.message).toBe(
          "This build of ready-for-agent is older than the database it is pointed at: " +
            "the database has 1 migration this binary does not recognize (20260102000000_unrecognized), " +
            "but this binary only knows about 1 migration. " +
            "Upgrade or reinstall ready-for-agent to a version built after those migrations, " +
            "or point it at a fresh database (e.g. set SQLITE_DATABASE_PATH to a new file).",
        )

        // Nothing else should have run: the known migration was not (re-)applied
        // and no other table was created before the fail-fast check ran.
        const tables = yield* sql`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('known_table', 'unrecognized_table')
        `
        expect(tables).toEqual([])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("rolls back all statements when a migration fails", async () => {
    const folder = await migrationFolder(
      "20260714120000_broken",
      [
        "CREATE TABLE partially_applied (id integer);",
        "--> statement-breakpoint",
        "INVALID SQL;",
      ].join("\n"),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const exit = yield* Effect.exit(runMigrations(folder))
        const tables = yield* sql`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'partially_applied'
        `

        expect(exit._tag).toBe("Failure")
        expect(tables).toEqual([])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("adopts the idempotent baseline on an existing schema", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260718055957_baseline/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        const migration = yield* Effect.exit(
          runMigrations(defaultMigrationsFolder),
        )
        expect(migration._tag).toBe("Success")

        const applied = yield* sql`SELECT name FROM __drizzle_migrations`
        expect(applied).toEqual([
          { name: "20260718055957_baseline" },
          { name: "20260718061640_right_black_bird" },
          { name: "20260720081709_cold_gladiator" },
          { name: "20260720220839_simple_rick_jones" },
          { name: "20260722034639_condemned_wildside" },
          { name: "20260722230410_goofy_gertrude_yorkes" },
          { name: "20260723051726_clever_hex" },
          { name: "20260723072032_free_shadow_king" },
          { name: "20260724001032_furry_wild_pack" },
          { name: "20260724120000_agent_backend_vocabulary" },
          { name: "20260724180000_agent_backend_selection" },
          { name: "20260724190000_work_item_turn_time_models" },
          { name: "20260725120000_backend_model_prefs" },
          { name: "20260725180000_repository_agent_backend_override" },
          { name: "20260725210211_wait_for_ready_for_review_checks" },
          { name: "20260726090000_waiting_for_blockers" },
          { name: "20260728120000_work_item_merge_mode" },
          { name: "20260729120000_work_item_publication_copy" },
          { name: "20260729160000_forge_identity_foundation" },
          { name: "20260730140857_unfinished_work_item_index" },
          { name: "20260807100000_postponed_step_runs" },
          { name: "20260808093000_explicit_agent_backend_selection" },
          { name: "20260811120000_step_run_reason_detail" },
          { name: "20260812120000_automated_review_rerun_signature" },
          { name: "20260814120000_work_item_execution_profile" },
          { name: "20260815120000_work_item_auto_merge_override" },
          { name: "20260815180000_autonomous_retry_budget" },
          { name: "20260818120000_repository_merge_policy" },
          { name: "20260819120000_repository_guaranteed_min_agent_turns" },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("accepts pre-squash history after the baseline was adopted", async () => {
    const baselineName = "20260718055957_baseline"
    const baselineSql = await readFile(
      join(
        import.meta.dir,
        `../../db-schema/drizzle/${baselineName}/migration.sql`,
      ),
      "utf8",
    )
    const baselineHash = createHash("sha256").update(baselineSql).digest("hex")

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        for (const statement of baselineSql.split("--> statement-breakpoint")) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }
        yield* sql`
          CREATE TABLE __drizzle_migrations (
            id INTEGER PRIMARY KEY,
            hash text NOT NULL,
            created_at numeric,
            name text,
            applied_at TEXT
          )
        `
        for (const [name, hash] of [
          ...preSquashMigrations,
          [baselineName, baselineHash] as const,
        ]) {
          yield* sql`
            INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
            VALUES (${hash}, ${Number(name.slice(0, 14))}, ${name}, ${"2026-07-18T06:00:00.000Z"})
          `
        }

        const result = yield* runMigrations(defaultMigrationsFolder)

        expect(result.applied.map((migration) => migration.name)).not.toContain(
          baselineName,
        )
        expect(
          yield* sql`SELECT count(*) AS count FROM __drizzle_migrations WHERE name IN (${baselineName}, ${preSquashMigrations[0][0]}, ${preSquashMigrations[22][0]})`,
        ).toEqual([{ count: 3 }])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("adds Step Run reason_detail for failure diagnostics", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* runMigrations(defaultMigrationsFolder)
        const columns = (yield* sql.unsafe(
          `PRAGMA table_info(step_run)`,
        )) as readonly { readonly name: string }[]
        const names = new Set(columns.map((column) => column.name))
        expect(names.has("reason_detail")).toBe(true)
        expect(names.has("reason_message")).toBe(true)
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("adds Explicit Work Item Execution Profile columns defaulting to absent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* runMigrations(defaultMigrationsFolder)
        const columns = (yield* sql.unsafe(
          `PRAGMA table_info(work_item)`,
        )) as readonly { readonly name: string }[]
        const names = new Set(columns.map((column) => column.name))
        expect(names.has("execution_profile_present")).toBe(true)
        expect(names.has("execution_profile_build_model")).toBe(true)
        expect(names.has("execution_profile_review_same_as_build")).toBe(true)
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("adds Autonomous Retry Budget table and pending-wait flag", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* runMigrations(defaultMigrationsFolder)
        const columns = (yield* sql.unsafe(
          `PRAGMA table_info(work_item)`,
        )) as readonly {
          readonly name: string
          readonly notnull: number
          readonly dflt_value: string | null
        }[]
        const pending = columns.find(
          (column) => column.name === "pending_autonomous_retry",
        )
        expect(pending).toBeDefined()
        expect(pending?.notnull).toBe(1)
        const tables = (yield* sql.unsafe(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'autonomous_retry'`,
        )) as readonly { readonly name: string }[]
        expect(tables).toEqual([{ name: "autonomous_retry" }])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("replaces Repository Auto-merge with Merge Policy off/classify/always", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260818120000_repository_merge_policy/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`
          CREATE TABLE repository (
            id text PRIMARY KEY,
            auto_merge integer NOT NULL DEFAULT 0
          )
        `)
        yield* sql.unsafe(
          `INSERT INTO repository VALUES
            ('repo-off', 0),
            ('repo-classify', 1)`,
        )

        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        const columns = (yield* sql.unsafe(
          `PRAGMA table_info(repository)`,
        )) as readonly {
          readonly name: string
          readonly dflt_value: string | null
        }[]
        const names = new Set(columns.map((column) => column.name))
        expect(names.has("merge_policy")).toBe(true)
        expect(names.has("auto_merge")).toBe(false)
        expect(
          columns.find((column) => column.name === "merge_policy")?.dflt_value,
        ).toBe("'off'")

        const rows = yield* sql.unsafe(
          `SELECT id, merge_policy FROM repository ORDER BY id`,
        )
        expect(rows).toEqual([
          { id: "repo-classify", merge_policy: "classify" },
          { id: "repo-off", merge_policy: "off" },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("adds a nullable Work Item Auto-merge override", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* runMigrations(defaultMigrationsFolder)
        const columns = (yield* sql.unsafe(
          `PRAGMA table_info(work_item)`,
        )) as readonly {
          readonly name: string
          readonly notnull: number
        }[]
        const override = columns.find(
          (column) => column.name === "auto_merge_override",
        )
        expect(override).toBeDefined()
        expect(override?.notnull).toBe(0)
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("adds Work Item publication title and body columns", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* runMigrations(defaultMigrationsFolder)
        const columns = (yield* sql.unsafe(
          `PRAGMA table_info(work_item)`,
        )) as readonly { readonly name: string }[]
        const names = new Set(columns.map((column) => column.name))
        expect(names.has("publication_title")).toBe(true)
        expect(names.has("publication_body")).toBe(true)
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("backfills Work Item Merge Mode ordinary and accepts Always", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260728120000_work_item_merge_mode/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`
          CREATE TABLE work_item (
            id text PRIMARY KEY,
            repository_id text NOT NULL,
            github_issue_number integer NOT NULL,
            state text NOT NULL
          )
        `)
        yield* sql.unsafe(
          `INSERT INTO work_item VALUES
            ('wi-existing', 'repo-1', 1, 'implement'),
            ('wi-other', 'repo-1', 2, 'complete')`,
        )

        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        const backfilled = yield* sql.unsafe(
          `SELECT id, merge_mode FROM work_item ORDER BY id`,
        )
        expect(backfilled).toEqual([
          { id: "wi-existing", merge_mode: "ordinary" },
          { id: "wi-other", merge_mode: "ordinary" },
        ])

        yield* sql.unsafe(
          `INSERT INTO work_item (id, repository_id, github_issue_number, state, merge_mode)
           VALUES ('wi-always', 'repo-1', 3, 'merge_pr', 'always')`,
        )
        const always = yield* sql.unsafe(
          `SELECT merge_mode FROM work_item WHERE id = 'wi-always'`,
        )
        expect(always).toEqual([{ merge_mode: "always" }])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("backfills the Step Run that handled an existing Needs Human handoff", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260720220839_simple_rick_jones/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `CREATE TABLE work_item (id text PRIMARY KEY, state text NOT NULL)`,
        )
        yield* sql.unsafe(
          `CREATE TABLE step_run (
             id text PRIMARY KEY,
             work_item_id text NOT NULL,
             step text NOT NULL,
             status text NOT NULL,
             queued_at integer NOT NULL,
             finished_at integer
           )`,
        )
        yield* sql.unsafe(
          `CREATE TABLE pr_status_check (
             id text PRIMARY KEY,
             work_item_id text NOT NULL,
             handled_at integer
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO work_item VALUES ('wi-existing', 'needs_human')`,
        )
        yield* sql.unsafe(
          `INSERT INTO step_run VALUES
             ('srun-existing', 'wi-existing', 'investigate_pr_status_checks', 'succeeded', 100, 200)`,
        )
        yield* sql.unsafe(
          `INSERT INTO pr_status_check VALUES
             ('psc-handoff', 'wi-existing', 200),
             ('psc-unrelated', 'wi-existing', 150)`,
        )

        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        const checks = yield* sql.unsafe(
          `SELECT id, handled_by_step_run_id
           FROM pr_status_check
           ORDER BY id`,
        )
        expect(checks).toEqual([
          {
            id: "psc-handoff",
            handled_by_step_run_id: "srun-existing",
          },
          { id: "psc-unrelated", handled_by_step_run_id: null },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("preserves historical Needs Human conflicts while rejecting new ones", async () => {
    const baselineSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260718055957_baseline/migration.sql",
      ),
      "utf8",
    )
    const migrationSql = baselineSql.slice(
      baselineSql.indexOf("CREATE TRIGGER"),
    )
    const folder = await migrationFolder(
      "20260717120000_needs_human_unfinished",
      migrationSql,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`
          CREATE TABLE work_item (
            id text PRIMARY KEY,
            repository_id text NOT NULL,
            github_issue_number integer NOT NULL,
            state text NOT NULL
          )
        `)
        yield* sql.unsafe(`
          CREATE UNIQUE INDEX work_item_one_unfinished_v2_uidx
          ON work_item (repository_id, github_issue_number)
          WHERE state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')
        `)
        yield* sql.unsafe(
          `INSERT INTO work_item VALUES
            ('old-handoff', 'repo-1', 42, 'needs_human'),
            ('new-attempt', 'repo-1', 42, 'implement')`,
        )

        const migration = yield* Effect.exit(runMigrations(folder))
        expect(migration._tag).toBe("Success")

        const insertConflict = yield* Effect.exit(
          sql.unsafe(
            `INSERT INTO work_item VALUES ('third-attempt', 'repo-1', 42, 'needs_human')`,
          ),
        )
        expect(insertConflict._tag).toBe("Failure")

        const resumeConflict = yield* Effect.exit(
          sql.unsafe(
            `UPDATE work_item SET state = 'local_cleanup' WHERE id = 'old-handoff'`,
          ),
        )
        expect(resumeConflict._tag).toBe("Failure")

        yield* sql.unsafe(
          `UPDATE work_item SET state = 'abandoned' WHERE id = 'new-attempt'`,
        )
        yield* sql.unsafe(
          `UPDATE work_item SET state = 'local_cleanup' WHERE id = 'old-handoff'`,
        )
        const rows = yield* sql.unsafe(
          `SELECT id, state FROM work_item ORDER BY id`,
        )
        expect(rows).toEqual([
          { id: "new-attempt", state: "abandoned" },
          { id: "old-handoff", state: "local_cleanup" },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("replaces the unfinished Work Item guards on a populated database without losing history", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260730140857_unfinished_work_item_index/migration.sql",
      ),
      "utf8",
    )
    const folder = await migrationFolder(
      "20260730140857_unfinished_work_item_index",
      migrationSql,
    )
    const states = [
      "create_worktree",
      "install_dependencies",
      "implement",
      "assess_changes",
      "pre_commit",
      "review",
      "commit",
      "create_pr",
      "watch_pr_status_checks",
      "resolve_pr_merge_conflict",
      "investigate_pr_status_checks",
      "mark_pr_ready_for_review",
      "decide_pr_merge",
      "merge_pr",
      "close_issue",
      "local_cleanup",
      "complete",
      "failed",
      "abandoned",
      "needs_human",
    ] as const

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`
          CREATE TABLE work_item (
            id text PRIMARY KEY,
            repository_id text NOT NULL,
            issue_number integer NOT NULL,
            state text NOT NULL
          )
        `)
        yield* sql.unsafe(`
          CREATE TABLE step_run (
            id text PRIMARY KEY,
            work_item_id text NOT NULL,
            step text NOT NULL
          )
        `)
        yield* sql.unsafe(`
          CREATE UNIQUE INDEX work_item_one_unfinished_v2_uidx
          ON work_item (repository_id, issue_number)
          WHERE state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')
        `)
        yield* sql.unsafe(`
          CREATE TRIGGER work_item_one_unfinished_v3_insert
          BEFORE INSERT ON work_item
          WHEN NEW.state NOT IN ('complete', 'failed', 'abandoned')
            AND EXISTS (
              SELECT 1 FROM work_item
              WHERE repository_id = NEW.repository_id
                AND issue_number = NEW.issue_number
                AND state NOT IN ('complete', 'failed', 'abandoned')
            )
          BEGIN
            SELECT RAISE(ABORT, 'work_item_one_unfinished_v3_uidx');
          END
        `)
        yield* sql.unsafe(`
          CREATE TRIGGER work_item_one_unfinished_v3_update
          BEFORE UPDATE OF repository_id, issue_number, state ON work_item
          WHEN NEW.state NOT IN ('complete', 'failed', 'abandoned')
            AND EXISTS (
              SELECT 1 FROM work_item
              WHERE id <> NEW.id
                AND repository_id = NEW.repository_id
                AND issue_number = NEW.issue_number
                AND state NOT IN ('complete', 'failed', 'abandoned')
            )
          BEGIN
            SELECT RAISE(ABORT, 'work_item_one_unfinished_v3_uidx');
          END
        `)

        for (const [index, state] of states.entries()) {
          const issueNumber =
            state === "complete" ||
            state === "failed" ||
            state === "abandoned" ||
            state === "needs_human"
              ? 900
              : index + 1
          yield* sql.unsafe(
            `INSERT INTO work_item (id, repository_id, issue_number, state)
             VALUES (?, 'repo-1', ?, ?)`,
            [`wi-${state}`, issueNumber, state],
          )
          yield* sql.unsafe(
            `INSERT INTO step_run (id, work_item_id, step) VALUES (?, ?, ?)`,
            [`srun-${state}`, `wi-${state}`, state],
          )
        }

        const workItemsBefore = yield* sql.unsafe(
          `SELECT id, repository_id, issue_number, state
           FROM work_item
           ORDER BY id`,
        )
        const stepRunsBefore = yield* sql.unsafe(
          `SELECT id, work_item_id, step FROM step_run ORDER BY id`,
        )

        const migration = yield* Effect.exit(runMigrations(folder))
        expect(migration._tag).toBe("Success")

        const workItemsAfter = yield* sql.unsafe(
          `SELECT id, repository_id, issue_number, state
           FROM work_item
           ORDER BY id`,
        )
        const stepRunsAfter = yield* sql.unsafe(
          `SELECT id, work_item_id, step FROM step_run ORDER BY id`,
        )
        expect(workItemsAfter).toEqual(workItemsBefore)
        expect(stepRunsAfter).toEqual(stepRunsBefore)

        const indexes = (yield* sql.unsafe(`
          SELECT name, sql
          FROM sqlite_master
          WHERE type = 'index'
            AND name LIKE 'work_item_one_unfinished%'
        `)) as readonly {
          readonly name: string
          readonly sql: string
        }[]
        expect(indexes).toHaveLength(1)
        expect(indexes[0]?.name).toBe("work_item_one_unfinished_v4_uidx")
        expect(indexes[0]?.sql).toContain(
          "NOT IN ('complete', 'failed', 'abandoned')",
        )
        expect(indexes[0]?.sql).not.toContain("needs_human")

        const triggers = yield* sql.unsafe(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'trigger'
            AND name LIKE 'work_item_one_unfinished_v3_%'
        `)
        expect(triggers).toEqual([])

        const needsHumanConflict = yield* Effect.exit(
          sql.unsafe(
            `INSERT INTO work_item (id, repository_id, issue_number, state)
             VALUES ('wi-conflict', 'repo-1', 900, 'implement')`,
          ),
        )
        expect(needsHumanConflict._tag).toBe("Failure")

        yield* sql.unsafe(
          `INSERT INTO work_item (id, repository_id, issue_number, state)
           VALUES ('wi-later-history', 'repo-1', 900, 'complete')`,
        )
        const preservedHistory = yield* sql.unsafe(
          `SELECT id FROM work_item WHERE issue_number = 900 ORDER BY id`,
        )
        expect(preservedHistory).toEqual([
          { id: "wi-abandoned" },
          { id: "wi-complete" },
          { id: "wi-failed" },
          { id: "wi-later-history" },
          { id: "wi-needs_human" },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("keeps the old index and rows when unexpected legacy conflicts block the replacement", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260730140857_unfinished_work_item_index/migration.sql",
      ),
      "utf8",
    )
    const folder = await migrationFolder(
      "20260730140857_unfinished_work_item_index",
      migrationSql,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`
          CREATE TABLE work_item (
            id text PRIMARY KEY,
            repository_id text NOT NULL,
            issue_number integer NOT NULL,
            state text NOT NULL
          )
        `)
        yield* sql.unsafe(`
          CREATE UNIQUE INDEX work_item_one_unfinished_v2_uidx
          ON work_item (repository_id, issue_number)
          WHERE state NOT IN ('complete', 'failed', 'abandoned', 'needs_human')
        `)
        yield* sql.unsafe(`
          INSERT INTO work_item VALUES
            ('wi-handoff', 'repo-1', 42, 'needs_human'),
            ('wi-conflict', 'repo-1', 42, 'implement')
        `)

        const migration = yield* Effect.exit(runMigrations(folder))
        expect(migration._tag).toBe("Failure")

        const indexes = yield* sql.unsafe(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'index'
            AND name LIKE 'work_item_one_unfinished%'
          ORDER BY name
        `)
        expect(indexes).toEqual([{ name: "work_item_one_unfinished_v2_uidx" }])
        const rows = yield* sql.unsafe(
          `SELECT id, state FROM work_item ORDER BY id`,
        )
        expect(rows).toEqual([
          { id: "wi-conflict", state: "implement" },
          { id: "wi-handoff", state: "needs_human" },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("adds Check-Start Anchor columns while preserving Work Items and PR Status Checks", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260723051726_clever_hex/migration.sql",
      ),
      "utf8",
    )
    const beforeMs = Date.now()

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `CREATE TABLE work_item (
             id text PRIMARY KEY,
             repository_id text NOT NULL,
             github_issue_number integer NOT NULL,
             state text NOT NULL,
             failure_code text
           )`,
        )
        yield* sql.unsafe(
          `CREATE TABLE pr_status_check (
             id text PRIMARY KEY,
             work_item_id text NOT NULL,
             external_id text NOT NULL,
             name text NOT NULL,
             outcome text NOT NULL
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO work_item VALUES
             ('wi-existing', 'repo-1', 42, 'watch_pr_status_checks', NULL),
             ('wi-retryable-failed', 'repo-1', 43, 'failed', 'pr_status_checks_unresolved'),
             ('wi-other-failed', 'repo-1', 44, 'failed', 'issue_not_found'),
             ('wi-complete', 'repo-1', 45, 'complete', NULL)`,
        )
        yield* sql.unsafe(
          `INSERT INTO pr_status_check VALUES
             ('psc-existing', 'wi-existing', 'checkrun:1', 'lint', 'green')`,
        )

        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        const afterMs = Date.now()
        const workItems = (yield* sql.unsafe(
          `SELECT id, state,
                  check_start_anchor_at,
                  check_start_anchor_head_sha,
                  check_start_observed_head_sha,
                  check_start_observed_head_at
           FROM work_item
           ORDER BY id`,
        )) as readonly {
          readonly id: string
          readonly state: string
          readonly check_start_anchor_at: number | null
          readonly check_start_anchor_head_sha: string | null
          readonly check_start_observed_head_sha: string | null
          readonly check_start_observed_head_at: number | null
        }[]

        expect(workItems).toHaveLength(4)
        const unfinished = workItems.find((row) => row.id === "wi-existing")
        const retryableFailed = workItems.find(
          (row) => row.id === "wi-retryable-failed",
        )
        const otherFailed = workItems.find(
          (row) => row.id === "wi-other-failed",
        )
        const complete = workItems.find((row) => row.id === "wi-complete")
        expect(unfinished).toMatchObject({
          state: "watch_pr_status_checks",
          check_start_anchor_head_sha: null,
          check_start_observed_head_sha: null,
          check_start_observed_head_at: null,
        })
        expect(unfinished?.check_start_anchor_at).not.toBeNull()
        expect(unfinished!.check_start_anchor_at!).toBeGreaterThanOrEqual(
          beforeMs,
        )
        expect(unfinished!.check_start_anchor_at!).toBeLessThanOrEqual(afterMs)
        expect(retryableFailed?.check_start_anchor_at).not.toBeNull()
        expect(retryableFailed!.check_start_anchor_at!).toBeGreaterThanOrEqual(
          beforeMs,
        )
        expect(retryableFailed!.check_start_anchor_at!).toBeLessThanOrEqual(
          afterMs,
        )
        expect(otherFailed).toEqual({
          id: "wi-other-failed",
          state: "failed",
          check_start_anchor_at: null,
          check_start_anchor_head_sha: null,
          check_start_observed_head_sha: null,
          check_start_observed_head_at: null,
        })
        expect(complete).toEqual({
          id: "wi-complete",
          state: "complete",
          check_start_anchor_at: null,
          check_start_anchor_head_sha: null,
          check_start_observed_head_sha: null,
          check_start_observed_head_at: null,
        })

        const checks = yield* sql.unsafe(
          `SELECT id, external_id FROM pr_status_check`,
        )
        expect(checks).toEqual([
          { id: "psc-existing", external_id: "checkrun:1" },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("defaults selected Agent Backend and backfills Work Item provenance as OpenCode", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260724180000_agent_backend_selection/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `CREATE TABLE config (
             id text PRIMARY KEY,
             default_model text,
             default_thinking_level text,
             review_model text,
             review_thinking_level text,
             max_concurrent_agent_turns integer NOT NULL DEFAULT 2,
             max_concurrent_work_items integer NOT NULL DEFAULT 5,
             created_at integer NOT NULL,
             updated_at integer NOT NULL
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO config (
             id, default_model, default_thinking_level, review_model, review_thinking_level,
             max_concurrent_agent_turns, max_concurrent_work_items, created_at, updated_at
           ) VALUES ('default', 'opencode/deepseek-v4-flash-free', 'low', NULL, NULL, 2, 5, 1, 1)`,
        )
        yield* sql.unsafe(
          `CREATE TABLE work_item (
             id text PRIMARY KEY,
             repository_id text NOT NULL,
             github_issue_number integer NOT NULL,
             model text NOT NULL,
             thinking_level text,
             review_model text NOT NULL,
             review_thinking_level text,
             state text NOT NULL,
             session_id text
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO work_item VALUES
             ('wi-existing', 'repo-1', 1, 'opencode/deepseek-v4-flash-free', 'low',
              'opencode/deepseek-v4-flash-free', 'low', 'implement', 'ses_old')`,
        )

        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        const configRows = yield* sql.unsafe(
          `SELECT selected_agent_backend, default_model, max_concurrent_agent_turns
           FROM config WHERE id = 'default'`,
        )
        expect(configRows).toEqual([
          {
            selected_agent_backend: "opencode",
            default_model: "opencode/deepseek-v4-flash-free",
            max_concurrent_agent_turns: 2,
          },
        ])

        const workItems = yield* sql.unsafe(
          `SELECT id, agent_backend, model, thinking_level, state, session_id
           FROM work_item WHERE id = 'wi-existing'`,
        )
        expect(workItems).toEqual([
          {
            id: "wi-existing",
            agent_backend: "opencode",
            model: "opencode/deepseek-v4-flash-free",
            thinking_level: "low",
            state: "implement",
            session_id: "ses_old",
          },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("migrates flat model columns into per-backend prefs JSON", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260725120000_backend_model_prefs/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `CREATE TABLE config (
             id text PRIMARY KEY,
             selected_agent_backend text NOT NULL DEFAULT 'opencode',
             default_model text,
             default_thinking_level text,
             review_model text,
             review_thinking_level text,
             max_concurrent_agent_turns integer NOT NULL DEFAULT 2,
             max_concurrent_work_items integer NOT NULL DEFAULT 5,
             created_at integer NOT NULL,
             updated_at integer NOT NULL
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO config (
             id, selected_agent_backend, default_model, default_thinking_level,
             review_model, review_thinking_level,
             max_concurrent_agent_turns, max_concurrent_work_items,
             created_at, updated_at
           ) VALUES (
             'default', 'opencode', 'openai/gpt-5.6-terra', 'high',
             'openai/gpt-5.6-terra', 'max', 2, 5, 1, 1
           )`,
        )
        yield* sql.unsafe(
          `CREATE TABLE repository (
             id text PRIMARY KEY,
             default_model text,
             default_thinking_level text,
             review_model text,
             review_thinking_level text
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO repository (
             id, default_model, default_thinking_level, review_model, review_thinking_level
           ) VALUES (
             'repo-1', 'openai/gpt-5.6-terra', 'high', NULL, NULL
           )`,
        )

        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        const configRows = (yield* sql.unsafe(
          `SELECT backend_model_prefs FROM config WHERE id = 'default'`,
        )) as readonly { backend_model_prefs: string }[]
        const configPrefs = JSON.parse(configRows[0]!.backend_model_prefs)
        expect(configPrefs).toEqual({
          opencode: {
            defaultModel: "openai/gpt-5.6-terra",
            defaultThinkingLevel: "high",
            reviewModel: "openai/gpt-5.6-terra",
            reviewThinkingLevel: "max",
          },
        })

        const repoRows = (yield* sql.unsafe(
          `SELECT backend_model_prefs FROM repository WHERE id = 'repo-1'`,
        )) as readonly { backend_model_prefs: string }[]
        const repoPrefs = JSON.parse(repoRows[0]!.backend_model_prefs)
        expect(repoPrefs).toEqual({
          opencode: {
            defaultModel: "openai/gpt-5.6-terra",
            defaultThinkingLevel: "high",
            reviewModel: null,
            reviewThinkingLevel: null,
          },
        })
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("adds nullable Repository Agent Backend override defaulting to inherit (null)", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260725180000_repository_agent_backend_override/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `CREATE TABLE repository (
             id text PRIMARY KEY,
             github_owner text NOT NULL,
             github_repo text NOT NULL
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO repository (id, github_owner, github_repo) VALUES
             ('repo-1', 'acme', 'widgets'),
             ('repo-2', 'acme', 'api')`,
        )

        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        const rows = yield* sql.unsafe(
          `SELECT id, selected_agent_backend
           FROM repository
           ORDER BY id`,
        )
        expect(rows).toEqual([
          { id: "repo-1", selected_agent_backend: null },
          { id: "repo-2", selected_agent_backend: null },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("adds wait_for_ready_for_review_checks defaulting to true for existing repositories", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260725210211_wait_for_ready_for_review_checks/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `CREATE TABLE repository (
             id text PRIMARY KEY,
             github_owner text NOT NULL,
             github_repo text NOT NULL
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO repository (id, github_owner, github_repo) VALUES
             ('repo-1', 'acme', 'widgets'),
             ('repo-2', 'acme', 'api')`,
        )

        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        const rows = yield* sql.unsafe(
          `SELECT id, wait_for_ready_for_review_checks
           FROM repository
           ORDER BY id`,
        )
        expect(rows).toEqual([
          { id: "repo-1", wait_for_ready_for_review_checks: 1 },
          { id: "repo-2", wait_for_ready_for_review_checks: 1 },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("enforces Postponed Step Run deadlines", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260807100000_postponed_step_runs/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `CREATE TABLE step_run (
             id text PRIMARY KEY,
             status text NOT NULL,
             finished_at integer
           )`,
        )
        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        yield* sql.unsafe(
          `INSERT INTO step_run (id, status, finished_at, postponed_until)
           VALUES ('queued', 'queued', NULL, NULL), ('postponed', 'postponed', 122, 123)`,
        )

        const missingDeadline = yield* Effect.exit(
          sql.unsafe(
            `INSERT INTO step_run (id, status, finished_at, postponed_until)
             VALUES ('missing-deadline', 'postponed', 122, NULL)`,
          ),
        )
        const missingFinishedAt = yield* Effect.exit(
          sql.unsafe(
            `INSERT INTO step_run (id, status, finished_at, postponed_until)
             VALUES ('missing-finished-at', 'postponed', NULL, 123)`,
          ),
        )
        const strayDeadline = yield* Effect.exit(
          sql.unsafe(
            `INSERT INTO step_run (id, status, finished_at, postponed_until)
             VALUES ('stray-deadline', 'queued', NULL, 123)`,
          ),
        )
        const clearingFinishedAt = yield* Effect.exit(
          sql.unsafe(
            `UPDATE step_run SET finished_at = NULL WHERE id = 'postponed'`,
          ),
        )

        expect(missingDeadline._tag).toBe("Failure")
        expect(missingFinishedAt._tag).toBe("Failure")
        expect(strayDeadline._tag).toBe("Failure")
        expect(clearingFinishedAt._tag).toBe("Failure")
        expect(
          yield* sql.unsafe(
            `SELECT id, status, finished_at, postponed_until
             FROM step_run ORDER BY id`,
          ),
        ).toEqual([
          {
            id: "postponed",
            status: "postponed",
            finished_at: 122,
            postponed_until: 123,
          },
          {
            id: "queued",
            status: "queued",
            finished_at: null,
            postponed_until: null,
          },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("marks existing Agent Backend selections as explicitly configured", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260808093000_explicit_agent_backend_selection/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `CREATE TABLE config (
             id text PRIMARY KEY,
             selected_agent_backend text NOT NULL,
             updated_at integer NOT NULL
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO config (id, selected_agent_backend, updated_at)
           VALUES ('default', 'claude', 123)`,
        )

        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        expect(
          yield* sql.unsafe(
            `SELECT selected_agent_backend, agent_backend_configured_at
             FROM config WHERE id = 'default'`,
          ),
        ).toEqual([
          {
            selected_agent_backend: "claude",
            agent_backend_configured_at: 123,
          },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("backfills Forge identity and renames issue and pull request numbers", async () => {
    const migrationSql = await readFile(
      join(
        import.meta.dir,
        "../../db-schema/drizzle/20260729160000_forge_identity_foundation/migration.sql",
      ),
      "utf8",
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const setupStatements = [
          `CREATE TABLE repository (
            id text PRIMARY KEY,
            github_owner text NOT NULL,
            github_repo text NOT NULL
          )`,
          `CREATE UNIQUE INDEX repository_github_owner_repo_lower_uidx
          ON repository (lower(github_owner), lower(github_repo))`,
          `CREATE TABLE issue (
            id text PRIMARY KEY,
            repository_id text NOT NULL,
            github_issue_number integer NOT NULL,
            parent_github_issue_number integer,
            parent_github_issue_url text
          )`,
          `CREATE UNIQUE INDEX issue_repository_id_github_issue_number_uidx
          ON issue (repository_id, github_issue_number)`,
          `CREATE TABLE issue_dependency (
            issue_id text NOT NULL,
            blocking_github_issue_number integer NOT NULL,
            blocking_github_issue_url text NOT NULL
          )`,
          `CREATE TABLE work_item (
            id text PRIMARY KEY,
            repository_id text NOT NULL,
            github_issue_number integer NOT NULL,
            github_pull_request_number integer
          )`,
          `INSERT INTO repository VALUES ('repo-1', 'Acme', 'Widgets')`,
          `INSERT INTO issue VALUES (
            'issue-1', 'repo-1', 42, 7,
            'https://github.com/Acme/Widgets/issues/7'
          )`,
          `INSERT INTO issue_dependency VALUES (
            'issue-1', 5, 'https://github.com/Acme/Widgets/issues/5'
          )`,
          `INSERT INTO work_item VALUES ('wi-1', 'repo-1', 42, 99)`,
        ]
        for (const statement of setupStatements) {
          yield* sql.unsafe(statement)
        }

        for (const statement of migrationSql.split(
          "--> statement-breakpoint",
        )) {
          if (statement.trim().length > 0) {
            yield* sql.unsafe(statement)
          }
        }

        expect(
          yield* sql.unsafe(
            `SELECT id, forge, forge_host, project_path FROM repository`,
          ),
        ).toEqual([
          {
            id: "repo-1",
            forge: "github",
            forge_host: "github.com",
            project_path: "Acme/Widgets",
          },
        ])
        expect(
          yield* sql.unsafe(
            `SELECT issue_number, parent_issue_number, parent_issue_url FROM issue`,
          ),
        ).toEqual([
          {
            issue_number: 42,
            parent_issue_number: 7,
            parent_issue_url: "https://github.com/Acme/Widgets/issues/7",
          },
        ])
        expect(
          yield* sql.unsafe(
            `SELECT blocking_issue_number, blocking_issue_url FROM issue_dependency`,
          ),
        ).toEqual([
          {
            blocking_issue_number: 5,
            blocking_issue_url: "https://github.com/Acme/Widgets/issues/5",
          },
        ])
        expect(
          yield* sql.unsafe(
            `SELECT issue_number, pull_request_number FROM work_item`,
          ),
        ).toEqual([{ issue_number: 42, pull_request_number: 99 }])

        const duplicate = yield* Effect.exit(
          sql.unsafe(
            `INSERT INTO repository (id, forge, forge_host, project_path)
             VALUES ('repo-2', 'github', 'github.com', 'acme/widgets')`,
          ),
        )
        expect(duplicate._tag).toBe("Failure")
      }).pipe(Effect.provide(SqliteTest)),
    )
  })
})
