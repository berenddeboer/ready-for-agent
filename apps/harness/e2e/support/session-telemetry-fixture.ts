/**
 * Deterministic Work Item / Session Telemetry fixtures for live e2e (issue #841).
 *
 * Seeds via the existing live-Harness control plane (stopped DB + restart).
 * Does not mock router internals — only Harness persistence and optional GraphQL
 * response shaping for outcomes that need a real OpenCode session store.
 */

import { expect } from "@playwright/test"
import { E2E_GRAPHQL_URL } from "./constants.ts"
import {
  CONTROL_FILES,
  readGeneration,
  readLiveHarnessState,
  writeControlFile,
} from "./live-harness-control.ts"

/**
 * Branded entity IDs must match DB schema patterns
 * (`repo-`/`wi-` + 26 Crockford ULID chars, no I/L/O/U). Fixed fixtures keep
 * scenarios deterministic across restarts.
 */
export const TELEMETRY_FIXTURE = {
  repositoryId: "repo-01KZD5SESS10NTE0FXX0000001",
  projectPath: "e2e/session-telemetry",
  /** OpenCode Work Item with a non-local Session id → MISSING telemetry. */
  missingSessionWorkItemId: "wi-01KZD5SESS10NTE0FXX0000001",
  missingSessionId: "ses_e2e_fixture_missing",
  /** Claude Work Item → UNSUPPORTED Session Telemetry. */
  unsupportedWorkItemId: "wi-01KZD5SESS10NTE0FXX0000002",
  unsupportedSessionId: "ses_e2e_fixture_unsupported",
} as const

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

const graphqlReachable = async (): Promise<boolean> => {
  try {
    const response = await fetch(E2E_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { config { defaultModel } }" }),
    })
    return response.ok
  } catch {
    return false
  }
}

const seedAndRestart = async (sql: string) => {
  const state = readLiveHarnessState()
  const before = readGeneration(state)
  writeControlFile(state, CONTROL_FILES.seedSql, sql)
  writeControlFile(state, CONTROL_FILES.restart, "1")
  await expect
    .poll(() => readGeneration(state), { timeout: 60_000, intervals: [250] })
    .toBeGreaterThan(before)
  await expect
    .poll(graphqlReachable, { timeout: 120_000, intervals: [500] })
    .toBe(true)
}

/**
 * Seed a paused Repository and Work Items that appear on Pipeline with
 * clickable Session IDs. Paused unfinished Work Items do not enqueue Step Runs.
 *
 * Does not write `config.default_model`: a non-catalog seed would leave Save
 * blocked for later settings-history scenarios in the same live Harness
 * process, and `ensureConfiguredDefaultBuildModel` is the shared catalog-safe
 * path for that. Callers that need first-run suppressed should use that helper
 * after seeding.
 */
export const seedSessionTelemetryFixtures = async (): Promise<void> => {
  const now = Date.now()
  const sql = [
    // Clear prior fixture rows so scenarios can re-seed safely.
    `DELETE FROM work_item WHERE repository_id = ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)};`,
    `DELETE FROM repository WHERE id = ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)};`,
    `INSERT INTO repository (
       id, forge, forge_host, project_path, local_path, is_bare, paused,
       created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       'github',
       'github.com',
       ${sqlLiteral(TELEMETRY_FIXTURE.projectPath)},
       ${sqlLiteral(`/tmp/${TELEMETRY_FIXTURE.repositoryId}`)},
       0,
       1,
       ${now},
       ${now}
     );`,
    `INSERT INTO work_item (
       id, repository_id, issue_number, issue_title, agent_backend,
       state, state_ready_at, paused, holds_worker_slot, session_id,
       created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.missingSessionWorkItemId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       101,
       'E2E Session Telemetry missing',
       'opencode',
       'implement',
       ${now},
       1,
       0,
       ${sqlLiteral(TELEMETRY_FIXTURE.missingSessionId)},
       ${now},
       ${now}
     );`,
    `INSERT INTO work_item (
       id, repository_id, issue_number, issue_title, agent_backend,
       state, state_ready_at, paused, holds_worker_slot, session_id,
       created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.unsupportedWorkItemId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       102,
       'E2E Session Telemetry unsupported',
       'claude',
       'implement',
       ${now},
       1,
       0,
       ${sqlLiteral(TELEMETRY_FIXTURE.unsupportedSessionId)},
       ${now},
       ${now}
     );`,
  ].join("\n")

  await seedAndRestart(sql)
}
