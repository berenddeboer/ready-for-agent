import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { SqliteTest } from "../src/lib/database-test.js"
import {
  defaultMigrationsFolder,
  runMigrationsFromSources,
} from "../src/lib/run-migrations.js"
import { describe, expect, it } from "bun:test"

const NEW_MIGRATION = "20261019150000_ci_repair_absent_issue_identity"

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

describe("CI Repair absent Issue identity migration", () => {
  it("clears sentinel Issue fields and keeps Issue uniqueness off CI Repair rows", async () => {
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
             id, repository_id, origin, issue_number, issue_tracker,
             issue_native_id, issue_display_id, issue_url, issue_title,
             state, state_ready_at, created_at, updated_at
           ) VALUES (
             'wi-ci-repair', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 'ci_repair',
             0, 'github', 'ci-repair', 'ci-repair', '',
             'Repair CI on main', 'implement', 1, 1, 1
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO work_item (
             id, repository_id, origin, issue_number, issue_tracker,
             issue_native_id, issue_display_id, issue_url, state,
             state_ready_at, created_at, updated_at
           ) VALUES (
             'wi-issue', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 'issue',
             42, 'github', '42', '42',
             'https://github.com/acme/widgets/issues/42',
             'implement', 1, 2, 2
           )`,
        )

        yield* runMigrationsFromSources([...prior, latest])

        const rows = (yield* sql.unsafe(
          `SELECT id,
                  issue_number AS issueNumber,
                  issue_tracker AS issueTracker,
                  issue_native_id AS issueNativeId,
                  issue_display_id AS issueDisplayId,
                  issue_url AS issueUrl
           FROM work_item
           ORDER BY id`,
        )) as readonly {
          readonly id: string
          readonly issueNumber: number | null
          readonly issueTracker: string | null
          readonly issueNativeId: string | null
          readonly issueDisplayId: string | null
          readonly issueUrl: string | null
        }[]
        expect(rows).toEqual([
          {
            id: "wi-ci-repair",
            issueNumber: null,
            issueTracker: null,
            issueNativeId: null,
            issueDisplayId: null,
            issueUrl: null,
          },
          {
            id: "wi-issue",
            issueNumber: 42,
            issueTracker: "github",
            issueNativeId: "42",
            issueDisplayId: "42",
            issueUrl: "https://github.com/acme/widgets/issues/42",
          },
        ])

        const indexes = (yield* sql.unsafe(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name LIKE 'work_item_one_unfinished%'
           ORDER BY name`,
        )) as readonly { readonly name: string }[]
        expect(indexes.map((index) => index.name)).toEqual([
          "work_item_one_unfinished_ci_repair_uidx",
          "work_item_one_unfinished_v6_uidx",
        ])

        yield* sql.unsafe(
          `INSERT INTO work_item (
             id, repository_id, origin, issue_number, issue_tracker,
             issue_native_id, issue_display_id, issue_url,
             state, state_ready_at, created_at, updated_at
           ) VALUES (
             'wi-ci-repair-null', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 'ci_repair',
             NULL, NULL, NULL, NULL, NULL,
             'complete', 1, 3, 3
           )`,
        )
        const describeError = (error: unknown): string => {
          const parts: string[] = []
          let current: unknown = error
          while (current) {
            if (current instanceof Error) {
              parts.push(current.message)
              if (
                "constraint" in current &&
                typeof current.constraint === "string"
              ) {
                parts.push(current.constraint)
              }
              current = current.cause
              continue
            }
            break
          }
          return parts.join(" ").toLowerCase()
        }
        const issueConflict = yield* Effect.flip(
          sql.unsafe(
            `INSERT INTO work_item (
               id, repository_id, origin, issue_number, issue_tracker,
               issue_native_id, issue_display_id, issue_url,
               state, state_ready_at, created_at, updated_at
             ) VALUES (
               'wi-issue-conflict', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 'issue',
               99, 'github', '42', '42',
               'https://github.com/acme/widgets/issues/42',
               'implement', 1, 4, 4
             )`,
          ),
        )
        const conflictText = describeError(issueConflict)
        expect(conflictText).toContain("unique")
        expect(conflictText).toContain("issue_native_id")
        expect(conflictText).not.toContain(
          "work_item_one_unfinished_ci_repair_uidx",
        )
      }).pipe(Effect.provide(SqliteTest)),
    )
  })
})
