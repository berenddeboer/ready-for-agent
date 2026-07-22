import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteTest } from "../src/lib/database-test.js"
import {
  defaultMigrationsFolder,
  runMigrations,
} from "../src/lib/run-migrations.js"
import { afterEach, describe, expect, it } from "bun:test"

const temporaryDirectories: Array<string> = []

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

describe("runMigrations", () => {
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
        ])
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
})
