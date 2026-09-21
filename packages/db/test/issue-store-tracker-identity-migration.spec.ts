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

const NEW_MIGRATION = "20260921140000_issue_store_tracker_identity"

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

describe("Issue store tracker identity migration", () => {
  it("backfills Issue native and display identity from the configured tracker", async () => {
    const sources = await loadMigrationSources()
    const latest = sources.find((source) => source.name === NEW_MIGRATION)
    if (latest === undefined) {
      throw new Error(`Missing migration ${NEW_MIGRATION}`)
    }
    const prior = sources.filter((source) => source.name !== NEW_MIGRATION)

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrationsFromSources(prior)
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `INSERT INTO repository (
             id, forge, issue_tracker, forge_host, project_path, local_path,
             is_bare, paused, selected_agent_backend, default_model,
             default_thinking_level, review_model, review_thinking_level,
             backend_model_prefs, merge_policy, include_all_issue_authors,
             wait_for_ready_for_review_checks, created_at, updated_at
           ) VALUES
           (
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 'github', 'github',
             'github.com', 'acme/widgets', '/repos/acme/widgets.git', 1, 1,
             NULL, NULL, NULL, NULL, NULL, '{}',
             'off', 0, 1, 1, 1
           ),
           (
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAW', 'gitlab', 'gitlab',
             'git.drupalcode.org', 'project/oauth_client',
             '/repos/gitlab/oauth.git', 1, 1,
             NULL, NULL, NULL, NULL, NULL, '{}',
             'off', 0, 1, 1, 1
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO issue (
             id, repository_id, issue_number, title, body, url, state,
             github_created_at, parent_issue_number, parent_issue_url,
             created_at, updated_at
           ) VALUES
           (
             'issue-github', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 42,
             'GitHub issue', 'body',
             'https://github.com/acme/widgets/issues/42', 'OPEN',
             1, 7, 'https://github.com/acme/widgets/issues/7', 1, 1
           ),
           (
             'issue-gitlab', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAW', 9,
             'GitLab issue', 'body',
             'https://git.drupalcode.org/project/oauth_client/-/issues/9',
             'OPEN', 1, NULL, NULL, 1, 1
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO issue_dependency (
             id, issue_id, blocking_issue_number, blocking_issue_url,
             created_at
           ) VALUES (
             'dep-1', 'issue-github', 17,
             'https://github.com/acme/widgets/issues/17', 1
           )`,
        )

        yield* runMigrationsFromSources([...prior, latest])

        const issues = (yield* sql.unsafe(
          `SELECT id, issue_tracker AS issueTracker,
                  issue_native_id AS nativeId,
                  issue_display_id AS displayId,
                  parent_native_id AS parentNativeId,
                  parent_display_id AS parentDisplayId
           FROM issue
           ORDER BY id`,
        )) as readonly {
          readonly id: string
          readonly issueTracker: string
          readonly nativeId: string
          readonly displayId: string
          readonly parentNativeId: string | null
          readonly parentDisplayId: string | null
        }[]
        expect(issues).toEqual([
          {
            id: "issue-github",
            issueTracker: "github",
            nativeId: "42",
            displayId: "42",
            parentNativeId: "7",
            parentDisplayId: "7",
          },
          {
            id: "issue-gitlab",
            issueTracker: "gitlab",
            nativeId: "9",
            displayId: "9",
            parentNativeId: null,
            parentDisplayId: null,
          },
        ])

        const dependencies = (yield* sql.unsafe(
          `SELECT blocking_native_id AS nativeId,
                  blocking_display_id AS displayId
           FROM issue_dependency`,
        )) as readonly {
          readonly nativeId: string
          readonly displayId: string
        }[]
        expect(dependencies).toEqual([{ nativeId: "17", displayId: "17" }])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })
})
