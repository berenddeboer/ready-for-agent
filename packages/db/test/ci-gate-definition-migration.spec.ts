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

const NEW_MIGRATION = "20260907120000_repository_ci_gate_definitions"

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

describe("CI Gate Definition migration", () => {
  it("leaves existing Repositories with no selections and unchanged settings", async () => {
    const sources = await loadMigrationSources()
    const prior = sources.filter((source) => source.name !== NEW_MIGRATION)
    const latest = sources.find((source) => source.name === NEW_MIGRATION)
    if (latest === undefined) {
      throw new Error(`Missing migration ${NEW_MIGRATION}`)
    }

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

        yield* runMigrationsFromSources([...prior, latest])

        const definitions = (yield* sql.unsafe(
          "SELECT identity FROM ci_gate_definition",
        )) as readonly { readonly identity: string }[]
        expect(definitions).toEqual([])

        const repositories = (yield* sql.unsafe(
          `SELECT paused, merge_policy AS mergePolicy,
                  include_all_issue_authors AS includeAllIssueAuthors,
                  wait_for_ready_for_review_checks AS waitForReadyForReviewChecks
           FROM repository
           WHERE id = 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV'`,
        )) as readonly {
          readonly paused: number | boolean
          readonly mergePolicy: string
          readonly includeAllIssueAuthors: number | boolean
          readonly waitForReadyForReviewChecks: number | boolean
        }[]
        expect(repositories).toHaveLength(1)
        expect(Number(repositories[0]?.paused)).toBe(1)
        expect(repositories[0]?.mergePolicy).toBe("off")
        expect(Number(repositories[0]?.includeAllIssueAuthors)).toBe(0)
        expect(Number(repositories[0]?.waitForReadyForReviewChecks)).toBe(1)
      }).pipe(Effect.provide(SqliteTest)),
    )
  })
})
