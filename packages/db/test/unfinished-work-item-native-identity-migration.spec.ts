import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { SqliteTest } from "../src/lib/database-test.js"
import {
  defaultMigrationsFolder,
  runMigrationsFromSources,
} from "../src/lib/run-migrations.js"
import { describe, expect, it } from "bun:test"

const NEW_MIGRATION = "20260921190000_unfinished_work_item_native_identity"

const loadMigrationSources = async () => {
  const names = (
    await readdir(defaultMigrationsFolder, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(
        join(defaultMigrationsFolder, name, "migration.sql"),
        "utf8",
      ),
    })),
  )
}

describe("unfinished Work Item native identity unique index", () => {
  it("keeps GitHub leftover unfinished work from blocking a Linear native identity", async () => {
    const sources = await loadMigrationSources()
    const latest = sources.find((source) => source.name === NEW_MIGRATION)
    if (latest === undefined) {
      throw new Error(`Missing migration ${NEW_MIGRATION}`)
    }
    const prior = sources.filter((source) => source.name < NEW_MIGRATION)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrationsFromSources(prior)
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `INSERT INTO repository (
             id, forge, forge_host, project_path, local_path, is_bare, paused,
             selected_agent_backend, default_model, default_thinking_level,
             review_model, review_thinking_level, backend_model_prefs,
             merge_policy, include_all_issue_authors,
             wait_for_ready_for_review_checks, created_at, updated_at
           ) VALUES (
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 'github', 'github.com',
             'acme/widgets', '/repos/acme/widgets.git', 1, 1,
             NULL, NULL, NULL, NULL, NULL, '{}',
             'off', 0, 1, 1, 1
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO work_item (
             id, repository_id, issue_number, issue_tracker, issue_native_id,
             issue_display_id, issue_url, state, state_ready_at,
             created_at, updated_at
           ) VALUES (
             'wi-github-leftover', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 123,
             'github', '123', '123',
             'https://github.com/acme/widgets/issues/123',
             'implement', 1, 1, 1
           )`,
        )

        yield* runMigrationsFromSources([...prior, latest])

        yield* sql.unsafe(
          `INSERT INTO work_item (
             id, repository_id, issue_number, issue_tracker, issue_native_id,
             issue_display_id, issue_url, state, state_ready_at,
             created_at, updated_at
           ) VALUES (
             'wi-linear', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 123,
             'linear', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'ENG-123',
             'https://linear.app/acme/issue/ENG-123',
             'implement', 1, 1, 1
           )`,
        )

        const indexes = (yield* sql.unsafe(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name LIKE 'work_item_one_unfinished%'
           ORDER BY name`,
        )) as readonly { readonly name: string }[]
        expect(indexes).toEqual([{ name: "work_item_one_unfinished_v5_uidx" }])

        const rows = (yield* sql.unsafe(
          `SELECT id, issue_tracker AS issueTracker, issue_native_id AS nativeId
           FROM work_item
           ORDER BY id`,
        )) as readonly {
          readonly id: string
          readonly issueTracker: string
          readonly nativeId: string
        }[]
        expect(rows).toEqual([
          {
            id: "wi-github-leftover",
            issueTracker: "github",
            nativeId: "123",
          },
          {
            id: "wi-linear",
            issueTracker: "linear",
            nativeId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("keeps the v4 index when unexpected native-id conflicts block the replacement", async () => {
    const sources = await loadMigrationSources()
    const latest = sources.find((source) => source.name === NEW_MIGRATION)
    if (latest === undefined) {
      throw new Error(`Missing migration ${NEW_MIGRATION}`)
    }
    const prior = sources.filter((source) => source.name < NEW_MIGRATION)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrationsFromSources(prior)
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `INSERT INTO repository (
             id, forge, forge_host, project_path, local_path, is_bare, paused,
             selected_agent_backend, default_model, default_thinking_level,
             review_model, review_thinking_level, backend_model_prefs,
             merge_policy, include_all_issue_authors,
             wait_for_ready_for_review_checks, created_at, updated_at
           ) VALUES (
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 'github', 'github.com',
             'acme/widgets', '/repos/acme/widgets.git', 1, 1,
             NULL, NULL, NULL, NULL, NULL, '{}',
             'off', 0, 1, 1, 1
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO work_item (
             id, repository_id, issue_number, issue_tracker, issue_native_id,
             issue_display_id, issue_url, state, state_ready_at,
             created_at, updated_at
           ) VALUES
           (
             'wi-native-a', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 123,
             'github', 'shared', '123',
             'https://github.com/acme/widgets/issues/123',
             'implement', 1, 1, 1
           ),
           (
             'wi-native-b', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 456,
             'github', 'shared', '456',
             'https://github.com/acme/widgets/issues/456',
             'implement', 1, 1, 1
           )`,
        )

        const migration = yield* Effect.exit(
          runMigrationsFromSources([...prior, latest]),
        )
        expect(migration._tag).toBe("Failure")

        const indexes = (yield* sql.unsafe(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name LIKE 'work_item_one_unfinished%'
           ORDER BY name`,
        )) as readonly { readonly name: string }[]
        expect(indexes).toEqual([{ name: "work_item_one_unfinished_v4_uidx" }])

        const rows = (yield* sql.unsafe(
          `SELECT id FROM work_item ORDER BY id`,
        )) as readonly { readonly id: string }[]
        expect(rows).toEqual([{ id: "wi-native-a" }, { id: "wi-native-b" }])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })
})
