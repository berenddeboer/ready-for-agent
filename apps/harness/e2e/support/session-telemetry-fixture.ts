/**
 * Deterministic Work Item / Session Telemetry fixtures for live e2e
 * (issues #841 / #1144).
 *
 * Seeds once per live Harness process via {@link ensureLiveHarnessPersistence}:
 * the first call writes rows against the stopped database and restarts; later
 * calls no-op when the fixtures are already present. Does not mock router
 * internals — only Harness persistence and optional GraphQL response shaping
 * for outcomes that need a real OpenCode session store.
 */

import { E2E_GRAPHQL_URL } from "./constants.ts"
import { ensureLiveHarnessPersistence } from "./live-harness-seed.ts"

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
  /**
   * OpenCode Work Item whose latest Agent Turn has no canonical activity
   * (issue #1144). Session usage is AVAILABLE via GraphQL shaping; the tail
   * peek is the empty Jump hint.
   */
  idleWorkItemId: "wi-01KZD5SESS10NTE0FXX0000005",
  idleSessionId: "ses_e2e_fixture_idle",
  idleIssueNumber: 105,
  idleIssueId: "issue-01KZD5SESS10NTE0FXX0000005",
} as const

/** Named Session Telemetry Work Items the operator-visible scenarios open. */
export const SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS = [
  TELEMETRY_FIXTURE.missingSessionWorkItemId,
  TELEMETRY_FIXTURE.codexMissingWorkItemId,
  TELEMETRY_FIXTURE.completedWorkItemId,
  TELEMETRY_FIXTURE.completedPageTwoWorkItemId,
  TELEMETRY_FIXTURE.idleWorkItemId,
] as const

/** Completed archive fillers that pin the page-2 fixture. */
const SESSION_TELEMETRY_FILLER_COUNT = 38

/** Named Work Items plus Completed pagination fillers. */
export const SESSION_TELEMETRY_FIXTURE_WORK_ITEM_COUNT =
  SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS.length +
  SESSION_TELEMETRY_FILLER_COUNT

export const sessionTelemetryFixturesArePresent = (
  workItems: ReadonlyArray<{ readonly id: string }>,
): boolean => {
  const ids = new Set(workItems.map((item) => item.id))
  return (
    SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS.every((id) => ids.has(id)) &&
    workItems.length >= SESSION_TELEMETRY_FIXTURE_WORK_ITEM_COUNT
  )
}

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

const workItemInsert = (input: {
  readonly id: string
  readonly issueNumber: number
  readonly issueTitle: string
  readonly agentBackend: "opencode" | "codex"
  readonly state: "implement" | "complete"
  readonly stateReadyAt: number
  readonly paused: 0 | 1
  readonly sessionId: string | null
  readonly createdAt: number
  readonly updatedAt: number
}): string => `INSERT INTO work_item (
       id, repository_id, issue_number, issue_tracker, issue_native_id,
       issue_display_id, issue_url, issue_title, agent_backend,
       state, state_ready_at, paused, holds_worker_slot, session_id,
       created_at, updated_at
     ) VALUES (
       ${sqlLiteral(input.id)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${input.issueNumber},
       'github',
       ${sqlLiteral(String(input.issueNumber))},
       ${sqlLiteral(String(input.issueNumber))},
       ${sqlLiteral(`https://github.com/${TELEMETRY_FIXTURE.projectPath}/issues/${input.issueNumber}`)},
       ${sqlLiteral(input.issueTitle)},
       ${sqlLiteral(input.agentBackend)},
       ${sqlLiteral(input.state)},
       ${input.stateReadyAt},
       ${input.paused},
       0,
       ${input.sessionId === null ? "NULL" : sqlLiteral(input.sessionId)},
       ${input.createdAt},
       ${input.updatedAt}
     );`

const sessionTelemetryFixturesPresent = async (): Promise<boolean> => {
  try {
    const response = await fetch(E2E_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `query SessionTelemetryFixtures($repositoryId: ID!) {
          workItems(repositoryId: $repositoryId) { id }
        }`,
        variables: { repositoryId: TELEMETRY_FIXTURE.repositoryId },
      }),
    })
    if (!response.ok) {
      return false
    }
    const payload = (await response.json()) as {
      data?: { workItems?: ReadonlyArray<{ id: string }> }
      errors?: ReadonlyArray<{ message: string }>
    }
    if (payload.errors?.length || payload.data?.workItems === undefined) {
      return false
    }
    return sessionTelemetryFixturesArePresent(payload.data.workItems)
  } catch {
    return false
  }
}

/**
 * SQL that seeds Session Telemetry fixtures. Unfinished Work Items must carry
 * distinct `(issue_tracker, issue_native_id)` values: bun:sqlite `exec` skips
 * unique-index failures without throwing, and
 * `work_item_one_unfinished_v5_uidx` would otherwise keep only the first
 * unfinished row (empty native-id default).
 */
export const sessionTelemetryFixtureSql = (now: number): string => {
  // Keep both Completed pages deterministic even when other e2e scenarios have
  // terminal Work Items. Future fixture timestamps sort ahead of all ordinary
  // rows: page 1 has the existing telemetry fixture + 19 fillers, and page 2
  // has the dedicated page-two fixture + 19 fillers.
  const completedOrderBase = now + 10_000_000_000
  const fillerWorkItems = Array.from(
    { length: SESSION_TELEMETRY_FILLER_COUNT },
    (_, index) => {
      const issueNumber = 200 + index
      const order =
        index < 19
          ? completedOrderBase + 199 - index
          : index < 33
            ? completedOrderBase + 69 - (index - 19)
            : completedOrderBase + 49 - (index - 33)
      const id = `wi-01KZD5SESS10NTE0F${String(index + 1).padStart(9, "0")}`
      return workItemInsert({
        id,
        issueNumber,
        issueTitle: `E2E Completed pagination filler ${index + 1}`,
        agentBackend: "opencode",
        state: "complete",
        stateReadyAt: order,
        paused: 0,
        sessionId: null,
        createdAt: order,
        updatedAt: order,
      })
    },
  )
  return [
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
       id, repository_id, issue_number, issue_tracker, issue_native_id,
       issue_display_id, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.missingSessionIssueId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.missingSessionIssueNumber},
       'github',
       ${sqlLiteral(String(TELEMETRY_FIXTURE.missingSessionIssueNumber))},
       ${sqlLiteral(String(TELEMETRY_FIXTURE.missingSessionIssueNumber))},
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
       id, repository_id, issue_number, issue_tracker, issue_native_id,
       issue_display_id, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.completedPageTwoIssueId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.completedPageTwoIssueNumber},
       'github',
       ${sqlLiteral(String(TELEMETRY_FIXTURE.completedPageTwoIssueNumber))},
       ${sqlLiteral(String(TELEMETRY_FIXTURE.completedPageTwoIssueNumber))},
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
       id, repository_id, issue_number, issue_tracker, issue_native_id,
       issue_display_id, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.codexMissingIssueId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.codexMissingIssueNumber},
       'github',
       ${sqlLiteral(String(TELEMETRY_FIXTURE.codexMissingIssueNumber))},
       ${sqlLiteral(String(TELEMETRY_FIXTURE.codexMissingIssueNumber))},
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
       id, repository_id, issue_number, issue_tracker, issue_native_id,
       issue_display_id, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.completedIssueId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.completedIssueNumber},
       'github',
       ${sqlLiteral(String(TELEMETRY_FIXTURE.completedIssueNumber))},
       ${sqlLiteral(String(TELEMETRY_FIXTURE.completedIssueNumber))},
       'E2E Session Telemetry completed',
       '',
       ${sqlLiteral(`https://github.com/${TELEMETRY_FIXTURE.projectPath}/issues/${TELEMETRY_FIXTURE.completedIssueNumber}`)},
       'CLOSED',
       ${now},
       0,
       ${now},
       ${now}
     );`,
    `INSERT INTO issue (
       id, repository_id, issue_number, issue_tracker, issue_native_id,
       issue_display_id, title, body, url, state,
       github_created_at, has_children, created_at, updated_at
     ) VALUES (
       ${sqlLiteral(TELEMETRY_FIXTURE.idleIssueId)},
       ${sqlLiteral(TELEMETRY_FIXTURE.repositoryId)},
       ${TELEMETRY_FIXTURE.idleIssueNumber},
       'github',
       ${sqlLiteral(String(TELEMETRY_FIXTURE.idleIssueNumber))},
       ${sqlLiteral(String(TELEMETRY_FIXTURE.idleIssueNumber))},
       'E2E Session usage idle OpenCode tail',
       '',
       ${sqlLiteral(`https://github.com/${TELEMETRY_FIXTURE.projectPath}/issues/${TELEMETRY_FIXTURE.idleIssueNumber}`)},
       'OPEN',
       ${now},
       0,
       ${now},
       ${now}
     );`,
    workItemInsert({
      id: TELEMETRY_FIXTURE.missingSessionWorkItemId,
      issueNumber: TELEMETRY_FIXTURE.missingSessionIssueNumber,
      issueTitle: "E2E Session Telemetry missing",
      agentBackend: "opencode",
      state: "implement",
      stateReadyAt: now,
      paused: 1,
      sessionId: TELEMETRY_FIXTURE.missingSessionId,
      createdAt: now,
      updatedAt: now,
    }),
    workItemInsert({
      id: TELEMETRY_FIXTURE.idleWorkItemId,
      issueNumber: TELEMETRY_FIXTURE.idleIssueNumber,
      issueTitle: "E2E Session usage idle OpenCode tail",
      agentBackend: "opencode",
      state: "implement",
      stateReadyAt: now,
      paused: 1,
      sessionId: TELEMETRY_FIXTURE.idleSessionId,
      createdAt: now,
      updatedAt: now,
    }),
    workItemInsert({
      id: TELEMETRY_FIXTURE.codexMissingWorkItemId,
      issueNumber: TELEMETRY_FIXTURE.codexMissingIssueNumber,
      issueTitle: "E2E Codex Session Telemetry missing",
      agentBackend: "codex",
      state: "implement",
      stateReadyAt: now,
      paused: 1,
      sessionId: TELEMETRY_FIXTURE.codexMissingSessionId,
      createdAt: now,
      updatedAt: now,
    }),
    workItemInsert({
      id: TELEMETRY_FIXTURE.completedWorkItemId,
      issueNumber: TELEMETRY_FIXTURE.completedIssueNumber,
      issueTitle: "E2E Session Telemetry completed",
      agentBackend: "opencode",
      state: "complete",
      stateReadyAt: completedOrderBase + 200,
      paused: 0,
      sessionId: TELEMETRY_FIXTURE.completedSessionId,
      createdAt: completedOrderBase + 200,
      updatedAt: completedOrderBase + 200,
    }),
    ...fillerWorkItems.slice(0, 19),
    workItemInsert({
      id: TELEMETRY_FIXTURE.completedPageTwoWorkItemId,
      issueNumber: TELEMETRY_FIXTURE.completedPageTwoIssueNumber,
      issueTitle: "E2E Session Telemetry completed page two",
      agentBackend: "opencode",
      state: "complete",
      stateReadyAt: completedOrderBase + 50,
      paused: 0,
      sessionId: TELEMETRY_FIXTURE.completedPageTwoSessionId,
      createdAt: completedOrderBase + 50,
      updatedAt: completedOrderBase + 50,
    }),
    ...fillerWorkItems.slice(19),
  ].join("\n")
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
  await ensureLiveHarnessPersistence({
    alreadyPresent: sessionTelemetryFixturesPresent,
    sql: sessionTelemetryFixtureSql(Date.now()),
  })
}
