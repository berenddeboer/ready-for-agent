import {
  IMPLEMENT_WITH_ISSUE_FIXTURE,
  implementWithIssueFixturesArePresent,
} from "../e2e/support/implement-with-issue-fixture.ts"
import {
  CONTROL_FILES,
  type LiveHarnessState,
} from "../e2e/support/live-harness-control.ts"
import {
  type LiveHarnessSeedControl,
  ensureLiveHarnessPersistence,
  seedLiveHarnessAndRestart,
} from "../e2e/support/live-harness-seed.ts"
import {
  PAUSED_REPOSITORY_FIXTURE,
  pausedRepositoryFixtureIsPresent,
} from "../e2e/support/paused-repository-fixture.ts"
import {
  SESSION_TELEMETRY_FIXTURE_WORK_ITEM_COUNT,
  SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS,
  TELEMETRY_FIXTURE,
  sessionTelemetryFixtureSql,
  sessionTelemetryFixturesArePresent,
} from "../e2e/support/session-telemetry-fixture.ts"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"

const state: LiveHarnessState = {
  dbPath: "/tmp/e2e-harness.db",
  controlDir: "/tmp/e2e-control",
}

const recordingControl = (): {
  control: LiveHarnessSeedControl
  files: Map<string, string>
  waitCalls: number
} => {
  const files = new Map<string, string>()
  let waitCalls = 0
  const control: LiveHarnessSeedControl = {
    readState: () => state,
    readGeneration: () => 3,
    writeControlFile: (_state, file, contents) => {
      files.set(file, contents)
    },
    waitForRestart: async () => {
      waitCalls += 1
    },
  }
  return {
    get waitCalls() {
      return waitCalls
    },
    control,
    files,
  }
}

describe("ensureLiveHarnessPersistence", () => {
  test("is a no-op when the seed is already present", async () => {
    const recording = recordingControl()

    const outcome = await ensureLiveHarnessPersistence(
      {
        alreadyPresent: async () => true,
        sql: "INSERT INTO repository (id) VALUES ('should-not-write');",
      },
      recording.control,
    )

    expect(outcome).toEqual({ kind: "already-present" })
    expect(recording.files.size).toBe(0)
    expect(recording.waitCalls).toBe(0)
  })

  test("seeds against the stopped database and restarts when missing", async () => {
    const recording = recordingControl()
    const sql = "INSERT INTO work_item (id) VALUES ('wi-missing');"

    const outcome = await ensureLiveHarnessPersistence(
      {
        alreadyPresent: async () => false,
        sql,
      },
      recording.control,
    )

    expect(outcome).toEqual({ kind: "seeded" })
    expect(recording.files.get(CONTROL_FILES.seedSql)).toBe(sql)
    expect(recording.files.get(CONTROL_FILES.restart)).toBe("1")
    expect(recording.waitCalls).toBe(1)
  })
})

describe("seedLiveHarnessAndRestart", () => {
  test("always requests a restart, including empty SQL for readiness-only changes", async () => {
    const recording = recordingControl()

    await seedLiveHarnessAndRestart("", recording.control)

    expect(recording.files.get(CONTROL_FILES.seedSql)).toBe("")
    expect(recording.files.get(CONTROL_FILES.restart)).toBe("1")
    expect(recording.waitCalls).toBe(1)
  })
})

describe("pausedRepositoryFixtureIsPresent", () => {
  const present = {
    id: PAUSED_REPOSITORY_FIXTURE.repositoryId,
    paused: true,
    issuesReconciledAt: "2026-08-13T10:00:00.000Z",
  }

  test("requires the seeded Paused Repository with Issue-store freshness", () => {
    expect(pausedRepositoryFixtureIsPresent([])).toBe(false)
    expect(
      pausedRepositoryFixtureIsPresent([
        {
          id: "repo-01KZW59OTHER0REP0FXX0000001",
          paused: true,
          issuesReconciledAt: "2026-08-13T10:00:00.000Z",
        },
      ]),
    ).toBe(false)
    expect(
      pausedRepositoryFixtureIsPresent([{ ...present, paused: false }]),
    ).toBe(false)
    expect(
      pausedRepositoryFixtureIsPresent([
        { ...present, issuesReconciledAt: null },
      ]),
    ).toBe(false)
    expect(pausedRepositoryFixtureIsPresent([present])).toBe(true)
  })
})

describe("sessionTelemetryFixturesArePresent", () => {
  test("requires the named Work Items and the Completed pagination fillers", () => {
    const named: ReadonlyArray<{ readonly id: string }> =
      SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS.map((id) => ({ id }))
    const fillers: ReadonlyArray<{ readonly id: string }> = Array.from(
      {
        length:
          SESSION_TELEMETRY_FIXTURE_WORK_ITEM_COUNT -
          SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS.length,
      },
      (_, index) => ({
        id: `wi-01KZD5SESS10NTE0F${String(index + 1).padStart(9, "0")}`,
      }),
    )

    expect(sessionTelemetryFixturesArePresent([])).toBe(false)
    expect(sessionTelemetryFixturesArePresent(named)).toBe(false)
    expect(sessionTelemetryFixturesArePresent([...named, ...fillers])).toBe(
      true,
    )
    expect(
      sessionTelemetryFixturesArePresent(
        named
          .filter((item) => item.id !== TELEMETRY_FIXTURE.completedWorkItemId)
          .concat(fillers),
      ),
    ).toBe(false)
  })

  test("unfinished Work Items insert under v5 native-id uniqueness", () => {
    const db = new Database(":memory:")
    db.exec(`
      CREATE TABLE work_item (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        issue_tracker TEXT NOT NULL DEFAULT 'github',
        issue_native_id TEXT NOT NULL DEFAULT '',
        issue_display_id TEXT NOT NULL DEFAULT '',
        issue_url TEXT NOT NULL DEFAULT '',
        issue_title TEXT,
        agent_backend TEXT NOT NULL DEFAULT 'opencode',
        state TEXT NOT NULL,
        state_ready_at INTEGER NOT NULL,
        paused INTEGER NOT NULL DEFAULT 0,
        holds_worker_slot INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX work_item_one_unfinished_v5_uidx
        ON work_item (repository_id, issue_tracker, issue_native_id)
        WHERE "work_item"."state" NOT IN ('complete', 'failed', 'abandoned');
    `)
    const sql = sessionTelemetryFixtureSql(1)
    const workItemSql = [
      ...sql.matchAll(/INSERT INTO work_item \([\s\S]*?\);/g),
    ]
      .map((match) => match[0])
      .join("\n")
    db.exec(workItemSql)

    const unfinished = db
      .query(
        `SELECT id, issue_native_id AS nativeId FROM work_item
         WHERE state NOT IN ('complete', 'failed', 'abandoned')
         ORDER BY id`,
      )
      .all() as ReadonlyArray<{
      readonly id: string
      readonly nativeId: string
    }>
    expect(unfinished).toEqual([
      {
        id: TELEMETRY_FIXTURE.missingSessionWorkItemId,
        nativeId: String(TELEMETRY_FIXTURE.missingSessionIssueNumber),
      },
      {
        id: TELEMETRY_FIXTURE.codexMissingWorkItemId,
        nativeId: String(TELEMETRY_FIXTURE.codexMissingIssueNumber),
      },
      {
        id: TELEMETRY_FIXTURE.idleWorkItemId,
        nativeId: String(TELEMETRY_FIXTURE.idleIssueNumber),
      },
    ])
    const namedCount = (
      db
        .query(
          `SELECT COUNT(*) AS count FROM work_item WHERE id IN (${SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS.map((id) => `'${id}'`).join(", ")})`,
        )
        .get() as { readonly count: number }
    ).count
    expect(namedCount).toBe(SESSION_TELEMETRY_FIXTURE_WORK_ITEM_IDS.length)
    const total = (
      db.query("SELECT COUNT(*) AS count FROM work_item").get() as {
        readonly count: number
      }
    ).count
    expect(total).toBe(SESSION_TELEMETRY_FIXTURE_WORK_ITEM_COUNT)
  })
})

describe("implementWithIssueFixturesArePresent", () => {
  const leaf = {
    id: IMPLEMENT_WITH_ISSUE_FIXTURE.leafIssueId,
    issueNumber: IMPLEMENT_WITH_ISSUE_FIXTURE.leafIssueNumber,
    hasChildren: false,
    parent: null,
  }
  const parent = {
    id: IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueId,
    issueNumber: IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueNumber,
    hasChildren: true,
    parent: null,
  }
  const child = {
    id: IMPLEMENT_WITH_ISSUE_FIXTURE.childIssueId,
    issueNumber: IMPLEMENT_WITH_ISSUE_FIXTURE.childIssueNumber,
    hasChildren: false,
    parent: { issueNumber: IMPLEMENT_WITH_ISSUE_FIXTURE.parentIssueNumber },
  }

  test("requires the leaf and supported parent/child pair", () => {
    expect(implementWithIssueFixturesArePresent([])).toBe(false)
    expect(implementWithIssueFixturesArePresent([leaf, parent])).toBe(false)
    expect(implementWithIssueFixturesArePresent([leaf, parent, child])).toBe(
      true,
    )
    expect(
      implementWithIssueFixturesArePresent([
        leaf,
        { ...parent, hasChildren: false },
        child,
      ]),
    ).toBe(false)
  })
})
