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

const NEW_MIGRATION = "20260921120000_independent_issue_tracker"

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

describe("independent Issue Tracker identity migration", () => {
  it("backfills Repositories and Work Items from hosting Forge identity", async () => {
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
           ) VALUES
           (
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 'github', 'github.com',
             'acme/widgets', '/repos/acme/widgets.git', 1, 1,
             NULL, NULL, NULL, NULL, NULL, '{}',
             'off', 0, 1, 1, 1
           ),
           (
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAW', 'gitlab', 'git.drupalcode.org',
             'project/oauth_client', '/repos/gitlab/oauth.git', 1, 1,
             NULL, NULL, NULL, NULL, NULL, '{}',
             'off', 0, 1, 1, 1
           ),
           (
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAX', 'azure-devops', 'dev.azure.com',
             'acme/widgets/other', '/repos/azure/other.git', 1, 1,
             NULL, NULL, NULL, NULL, NULL, '{}',
             'off', 0, 1, 1, 1
           ),
           (
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAY', 'azure-devops', 'dev.azure.com',
             'acme/boards', '/repos/azure/boards.git', 1, 1,
             NULL, NULL, NULL, NULL, NULL, '{}',
             'off', 0, 1, 1, 1
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO issue (
             id, repository_id, issue_number, title, body, url, state,
             github_created_at, created_at, updated_at
           ) VALUES (
             'issue-live', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 42,
             'Live issue', 'body',
             'https://github.com/acme/widgets/issues/42', 'OPEN',
             1, 1, 1
           )`,
        )
        yield* sql.unsafe(
          `INSERT INTO work_item (
             id, repository_id, issue_number, state, state_ready_at,
             created_at, updated_at
           ) VALUES
           (
             'wi-with-issue', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV', 42,
             'implement', 1, 1, 1
           ),
           (
             'wi-historical', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAW', 7,
             'complete', 1, 1, 1
           ),
           (
             'wi-azure-three-segment', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAX', 11,
             'complete', 1, 1, 1
           ),
           (
             'wi-azure-two-segment', 'repo-01ARZ3NDEKTSV4RRFFQ69G5FAY', 12,
             'complete', 1, 1, 1
           )`,
        )

        yield* runMigrationsFromSources([...prior, latest])

        const repositories = (yield* sql.unsafe(
          `SELECT id, forge, issue_tracker AS issueTracker
           FROM repository
           ORDER BY id`,
        )) as readonly {
          readonly id: string
          readonly forge: string
          readonly issueTracker: string
        }[]
        expect(repositories).toEqual([
          {
            id: "repo-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            forge: "github",
            issueTracker: "github",
          },
          {
            id: "repo-01ARZ3NDEKTSV4RRFFQ69G5FAW",
            forge: "gitlab",
            issueTracker: "gitlab",
          },
          {
            id: "repo-01ARZ3NDEKTSV4RRFFQ69G5FAX",
            forge: "azure-devops",
            issueTracker: "azure-devops",
          },
          {
            id: "repo-01ARZ3NDEKTSV4RRFFQ69G5FAY",
            forge: "azure-devops",
            issueTracker: "azure-devops",
          },
        ])

        const workItems = (yield* sql.unsafe(
          `SELECT id, issue_number AS issueNumber, issue_tracker AS issueTracker,
                  issue_native_id AS issueNativeId,
                  issue_display_id AS issueDisplayId, issue_url AS issueUrl
           FROM work_item
           ORDER BY id`,
        )) as readonly {
          readonly id: string
          readonly issueNumber: number
          readonly issueTracker: string
          readonly issueNativeId: string
          readonly issueDisplayId: string
          readonly issueUrl: string
        }[]
        expect(workItems).toEqual([
          {
            id: "wi-azure-three-segment",
            issueNumber: 11,
            issueTracker: "azure-devops",
            issueNativeId: "11",
            issueDisplayId: "11",
            issueUrl: "https://dev.azure.com/acme/widgets/_workitems/edit/11",
          },
          {
            id: "wi-azure-two-segment",
            issueNumber: 12,
            issueTracker: "azure-devops",
            issueNativeId: "12",
            issueDisplayId: "12",
            issueUrl: "https://dev.azure.com/acme/boards/_workitems/edit/12",
          },
          {
            id: "wi-historical",
            issueNumber: 7,
            issueTracker: "gitlab",
            issueNativeId: "7",
            issueDisplayId: "7",
            issueUrl:
              "https://git.drupalcode.org/project/oauth_client/-/issues/7",
          },
          {
            id: "wi-with-issue",
            issueNumber: 42,
            issueTracker: "github",
            issueNativeId: "42",
            issueDisplayId: "42",
            issueUrl: "https://github.com/acme/widgets/issues/42",
          },
        ])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })
})
