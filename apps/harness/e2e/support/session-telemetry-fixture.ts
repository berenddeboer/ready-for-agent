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
  missingSessionIssueNumber: 101,
  missingSessionIssueId: "issue-01KZD5SESS10NTE0FXX0000001",
  /** Codex Build Work Item with a non-local Session id → MISSING telemetry. */
  codexMissingWorkItemId: "wi-01KZD5SESS10NTE0FXX0000002",
  codexMissingSessionId: "ses_e2e_fixture_codex_missing",
  codexMissingIssueNumber: 102,
  codexMissingIssueId: "issue-01KZD5SESS10NTE0FXX0000002",
  /**
   * Complete Work Item for the Completed archive surface (issue #843).
   * Distinct Session id so openers are unambiguous when both surfaces list
   * session buttons.
   */
  completedWorkItemId: "wi-01KZD5SESS10NTE0FXX0000003",
  completedSessionId: "ses_e2e_fixture_completed",
  completedIssueNumber: 103,
  completedIssueId: "issue-01KZD5SESS10NTE0FXX0000003",
  /** Complete Work Item pinned to page 2 of the Completed archive. */
  completedPageTwoWorkItemId: "wi-01KZD5SESS10NTE0FXX0000004",
  completedPageTwoSessionId: "ses_e2e_fixture_completed_page_two",
  completedPageTwoIssueNumber: 104,
  completedPageTwoIssueId: "issue-01KZD5SESS10NTE0FXX0000004",
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
 * Seed a paused Repository, projected Issues, and Work Items so Session
 * Telemetry openers are clickable on Pipeline, Repos, and Completed.
 * Paused unfinished Work Items do not enqueue Step Runs.
 *
 * Does not write `config.default_model`: a non-catalog seed would leave Save
 * blocked for later settings-history scenarios in the same live Harness
 * process, and `ensureConfiguredDefaultBuildModel` is the shared catalog-safe
 * path for that. Callers that need first-run suppressed should use that helper
 * after seeding.
 */
export const seedSessionTelemetryFixtures = async (): Promise<void> => {
  const now = Date.now()
  // Keep both Completed pages deterministic even when other e2e scenarios have
  // terminal Work Items. Future fixture timestamps sort ahead of all ordinary
  // rows: page 1 has the existing telemetry fixture + 19 fillers, and page 2
  // has the dedicated page-two fixture + 19 fillers.
  const completedOrderBase = now + 10_000_000_000
  const fillerWorkItems = Array.from({ length: 38 }, (_, index) => {
    const issueNumber = 200 + index
    const order =
      index < 19
        ? completedOrderBase + 199 - index
        : index < 33
          ? completedOrderBase + 69 - (index - 19)
          : completedOrderBase + 49 - (index - 33)
    const id = `wi-01KZD5SESS10NTE0F${String(index + 1).padStart(9, "0")}`
    return `INSERT INTO work_item (
       id, repository_id, issue_number, issue_title, agent_backend,
       state, state_ready_at, paused, holds_worker_slot, session_id,
       created_at, updated_at
     ) VALUES (
       ${sqlLiteral(id)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${issueNumber},
       ${sqlLiteral(`E2E Completed pagination filler ${index + 1}`)},
       'opencode',
       'complete',
       ${order},
       0,
       0,
       NULL,
       ${order},
       ${order}
     );`
  })
  const sql = [
    // Clear prior fixture rows so scenarios can re-seed safely.
    `DELETE FROM work_item WHERE repository_id = ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)};`,
    `DELETE FROM issue WHERE repository_id = ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)};`,
    `DELETE FROM repository WHERE id = ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)};`,
    // issues_reconciled_at must be set so Repos renders the projected issues
    // list (and Session openers) without requiring a live Forge refresh.
    `INSERT INTO repository (
       id, forge, forge_host, project_path, local_path, is_bare, paused,
       issues_reconciled_at, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       'github',
       'github.com',
       ${sqlLiteral(TELEMETRY_FIXTURE.projectPath)},
       ${sqlLiteral(`/tmp/${TELEMETRY_FIXTURE.repositoryId}`)},
       0,
       1,
       ${now},
       ${now},
       ${now}
     );`,
    // Projected issues so Repos lists lifecycle chrome (and Completed titles).
    `INSERT INTO issue (
       id, repository_id, issue_number, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.missingSessionIssueId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.missingSessionIssueNumber},
       'E2E Session Telemetry missing',
       '',
       ${sqlLiteral(`https://github.com/${TELEMETRY_FIXTURE.projectPath}/issues/${TELEMETRY_FIXTURE.missingSessionIssueNumber}`)},
       'OPEN',
       ${now},
       0,
       ${now},
       ${now}
     );`,
    `INSERT INTO issue (
       id, repository_id, issue_number, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.completedPageTwoIssueId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.completedPageTwoIssueNumber},
       'E2E Session Telemetry completed page two',
       '',
       ${sqlLiteral(`https://github.com/${TELEMETRY_FIXTURE.projectPath}/issues/${TELEMETRY_FIXTURE.completedPageTwoIssueNumber}`)},
       'CLOSED',
       ${now},
       0,
       ${now},
       ${now}
     );`,
    `INSERT INTO issue (
       id, repository_id, issue_number, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.codexMissingIssueId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.codexMissingIssueNumber},
       'E2E Codex Session Telemetry missing',
       '',
       ${sqlLiteral(`https://github.com/${TELEMETRY_FIXTURE.projectPath}/issues/${TELEMETRY_FIXTURE.codexMissingIssueNumber}`)},
       'OPEN',
       ${now},
       0,
       ${now},
       ${now}
     );`,
    `INSERT INTO issue (
       id, repository_id, issue_number, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.completedIssueId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.completedIssueNumber},
       'E2E Session Telemetry completed',
       '',
       ${sqlLiteral(`https://github.com/${TELEMETRY_FIXTURE.projectPath}/issues/${TELEMETRY_FIXTURE.completedIssueNumber}`)},
       'CLOSED',
       ${now},
       0,
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
       ${TELEMETRY_FIXTURE.missingSessionIssueNumber},
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
       ${sqlLiteral(TELEMETRY_FIXTURE.codexMissingWorkItemId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.codexMissingIssueNumber},
       'E2E Codex Session Telemetry missing',
       'codex',
       'implement',
       ${now},
       1,
       0,
       ${sqlLiteral(TELEMETRY_FIXTURE.codexMissingSessionId)},
       ${now},
       ${now}
     );`,
    `INSERT INTO work_item (
       id, repository_id, issue_number, issue_title, agent_backend,
       state, state_ready_at, paused, holds_worker_slot, session_id,
       created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.completedWorkItemId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.completedIssueNumber},
       'E2E Session Telemetry completed',
       'opencode',
       'complete',
       ${completedOrderBase + 200},
       0,
       0,
       ${sqlLiteral(TELEMETRY_FIXTURE.completedSessionId)},
       ${completedOrderBase + 200},
       ${completedOrderBase + 200}
     );`,
    ...fillerWorkItems.slice(0, 19),
    `INSERT INTO work_item (
       id, repository_id, issue_number, issue_title, agent_backend,
       state, state_ready_at, paused, holds_worker_slot, session_id,
       created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.completedPageTwoWorkItemId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.completedPageTwoIssueNumber},
       'E2E Session Telemetry completed page two',
       'opencode',
       'complete',
       ${completedOrderBase + 50},
       0,
       0,
       ${sqlLiteral(TELEMETRY_FIXTURE.completedPageTwoSessionId)},
       ${completedOrderBase + 50},
       ${completedOrderBase + 50}
     );`,
    ...fillerWorkItems.slice(19),
  ].join("\n")

  await seedAndRestart(sql)
}
