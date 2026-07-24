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
          { name: "20260722230410_goofy_gertrude_yorkes" },
          { name: "20260723051726_clever_hex" },
          { name: "20260723072032_free_shadow_king" },
          { name: "20260724001032_furry_wild_pack" },
          { name: "20260724120000_agent_backend_vocabulary" },
          { name: "20260724180000_agent_backend_selection" },
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
})
