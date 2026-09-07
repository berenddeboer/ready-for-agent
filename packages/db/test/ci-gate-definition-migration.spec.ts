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
const OBSERVATION_MIGRATION = "20260907133000_repository_ci_gate_observation"
const HOLD_MIGRATION = "20260907150000_work_item_waiting_for_ci_repair"
const AUTHORIZATION_MIGRATION = "20260907160000_ci_repair_authorization"

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

  it("leaves existing Repositories without CI Gate observations or incidents", async () => {
    const sources = await loadMigrationSources()
    const observation = sources.find(
      (source) => source.name === OBSERVATION_MIGRATION,
    )
    if (observation === undefined) {
      throw new Error(`Missing migration ${OBSERVATION_MIGRATION}`)
    }
    const prior = sources.filter(
      (source) => source.name !== OBSERVATION_MIGRATION,
    )

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
          `INSERT INTO ci_gate_definition (
             id, repository_id, identity, display_label, kind,
             diagnostic_metadata, created_at, updated_at
           ) VALUES (
             'cgd-01ARZ3NDEKTSV4RRFFQ69G5FAV',
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV',
             '161335', 'CI', 'workflow', '.github/workflows/ci.yml', 1, 1
           )`,
        )

        yield* runMigrationsFromSources([...prior, observation])

        const states = (yield* sql.unsafe(
          "SELECT repository_id FROM ci_gate_state",
        )) as readonly unknown[]
        const observations = (yield* sql.unsafe(
          "SELECT definition_identity FROM ci_gate_definition_observation",
        )) as readonly unknown[]
        const incidents = (yield* sql.unsafe(
          "SELECT id FROM ci_failure_incident",
        )) as readonly unknown[]
        expect(states).toEqual([])
        expect(observations).toEqual([])
        expect(incidents).toEqual([])

        const definitions = (yield* sql.unsafe(
          "SELECT identity FROM ci_gate_definition",
        )) as readonly { readonly identity: string }[]
        expect(definitions).toEqual([{ identity: "161335" }])
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("leaves existing Work Items without a Waiting for CI Repair hold", async () => {
    const sources = await loadMigrationSources()
    const hold = sources.find((source) => source.name === HOLD_MIGRATION)
    if (hold === undefined) {
      throw new Error(`Missing migration ${HOLD_MIGRATION}`)
    }
    const prior = sources.filter((source) => source.name !== HOLD_MIGRATION)

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
             id, repository_id, issue_number, state, state_ready_at,
             paused, waiting_for_blockers, holds_worker_slot, created_at, updated_at
           ) VALUES (
             'wi-01ARZ3NDEKTSV4RRFFQ69G5FAV',
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV',
             42, 'merge_pr', 1, 0, 0, 1, 1, 1
           )`,
        )

        yield* runMigrationsFromSources([...prior, hold])

        const rows = (yield* sql.unsafe(
          `SELECT waiting_for_ci_repair AS waitingForCiRepair,
                  waiting_for_blockers AS waitingForBlockers,
                  holds_worker_slot AS holdsWorkerSlot,
                  state
           FROM work_item
           WHERE id = 'wi-01ARZ3NDEKTSV4RRFFQ69G5FAV'`,
        )) as readonly {
          readonly waitingForCiRepair: number | boolean
          readonly waitingForBlockers: number | boolean
          readonly holdsWorkerSlot: number | boolean
          readonly state: string
        }[]
        expect(rows).toHaveLength(1)
        expect(Number(rows[0]?.waitingForCiRepair)).toBe(0)
        expect(Number(rows[0]?.waitingForBlockers)).toBe(0)
        expect(Number(rows[0]?.holdsWorkerSlot)).toBe(1)
        expect(rows[0]?.state).toBe("merge_pr")
      }).pipe(Effect.provide(SqliteTest)),
    )
  })

  it("leaves existing Work Items without CI Repair authorization", async () => {
    const sources = await loadMigrationSources()
    const authorization = sources.find(
      (source) => source.name === AUTHORIZATION_MIGRATION,
    )
    if (authorization === undefined) {
      throw new Error(`Missing migration ${AUTHORIZATION_MIGRATION}`)
    }
    const prior = sources.filter(
      (source) => source.name !== AUTHORIZATION_MIGRATION,
    )

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
             id, repository_id, issue_number, state, state_ready_at,
             paused, waiting_for_blockers, waiting_for_ci_repair,
             holds_worker_slot, created_at, updated_at
           ) VALUES (
             'wi-01ARZ3NDEKTSV4RRFFQ69G5FAV',
             'repo-01ARZ3NDEKTSV4RRFFQ69G5FAV',
             42, 'merge_pr', 1, 0, 0, 0, 1, 1, 1
           )`,
        )

        yield* runMigrationsFromSources([...prior, authorization])

        const rows = (yield* sql.unsafe(
          "SELECT id FROM ci_repair_authorization",
        )) as readonly unknown[]
        expect(rows).toEqual([])
        const workItems = (yield* sql.unsafe(
          `SELECT waiting_for_ci_repair AS waitingForCiRepair, state
           FROM work_item
           WHERE id = 'wi-01ARZ3NDEKTSV4RRFFQ69G5FAV'`,
        )) as readonly {
          readonly waitingForCiRepair: number | boolean
          readonly state: string
        }[]
        expect(Number(workItems[0]?.waitingForCiRepair)).toBe(0)
        expect(workItems[0]?.state).toBe("merge_pr")
      }).pipe(Effect.provide(SqliteTest)),
    )
  })
})
