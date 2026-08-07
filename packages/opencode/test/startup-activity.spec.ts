import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect } from "effect"
import {
  hasOpencodeTaskSubagentActivity,
  observeOpencodeStartupActivity,
} from "../src/lib/startup-activity.js"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"

const createFixtureDb = (dir: string): string => {
  const path = join(dir, "opencode.db")
  const db = new Database(path)
  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY,
      project_id text NOT NULL DEFAULT 'proj',
      parent_id text,
      slug text NOT NULL DEFAULT 'slug',
      directory text NOT NULL DEFAULT '/tmp',
      title text NOT NULL DEFAULT 'title',
      version text NOT NULL DEFAULT '1',
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL DEFAULT 'msg',
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `)
  db.close()
  return path
}

const insertSession = (
  dbPath: string,
  row: {
    readonly id: string
    readonly parentId?: string
    readonly timeCreated: number
    readonly timeUpdated: number
  },
): void => {
  const db = new Database(dbPath)
  db.query(
    `INSERT INTO session (id, parent_id, time_created, time_updated)
     VALUES (?, ?, ?, ?)`,
  ).run(row.id, row.parentId ?? null, row.timeCreated, row.timeUpdated)
  db.close()
}

const insertPart = (
  dbPath: string,
  row: {
    readonly id: string
    readonly sessionId: string
    readonly timeCreated: number
    readonly data: string
  },
): void => {
  const db = new Database(dbPath)
  db.query(
    `INSERT INTO part (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.id, row.sessionId, row.timeCreated, row.timeCreated, row.data)
  db.close()
}

describe("hasOpencodeTaskSubagentActivity", () => {
  test("returns false when the database is missing", () => {
    expect(
      hasOpencodeTaskSubagentActivity(
        join(tmpdir(), "no-such-opencode-startup.db"),
        "ses_parent",
        Date.now(),
      ),
    ).toBe(false)
  })

  test("detects a child session created after the turn started", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-startup-"))
    try {
      const dbPath = createFixtureDb(dir)
      const startedAfterMs = 1_000
      insertSession(dbPath, {
        id: "ses_parent",
        timeCreated: 100,
        timeUpdated: 100,
      })
      insertSession(dbPath, {
        id: "ses_child",
        parentId: "ses_parent",
        timeCreated: startedAfterMs + 50,
        timeUpdated: startedAfterMs + 50,
      })
      expect(
        hasOpencodeTaskSubagentActivity(dbPath, "ses_parent", startedAfterMs),
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("ignores historical child sessions from earlier turns", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-startup-"))
    try {
      const dbPath = createFixtureDb(dir)
      const startedAfterMs = 5_000
      insertSession(dbPath, {
        id: "ses_parent",
        timeCreated: 100,
        timeUpdated: 100,
      })
      insertSession(dbPath, {
        id: "ses_old_child",
        parentId: "ses_parent",
        timeCreated: 200,
        timeUpdated: 300,
      })
      expect(
        hasOpencodeTaskSubagentActivity(dbPath, "ses_parent", startedAfterMs),
      ).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("ignores a historical child whose time_updated advances after the turn started", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-startup-"))
    try {
      const dbPath = createFixtureDb(dir)
      const startedAfterMs = 5_000
      insertSession(dbPath, {
        id: "ses_parent",
        timeCreated: 100,
        timeUpdated: 100,
      })
      // Old child created long before the turn; bookkeeping bumps time_updated.
      insertSession(dbPath, {
        id: "ses_old_child",
        parentId: "ses_parent",
        timeCreated: 200,
        timeUpdated: startedAfterMs + 500,
      })
      expect(
        hasOpencodeTaskSubagentActivity(dbPath, "ses_parent", startedAfterMs),
      ).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("detects a parent task part created after the turn started", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-startup-"))
    try {
      const dbPath = createFixtureDb(dir)
      const startedAfterMs = 1_000
      insertSession(dbPath, {
        id: "ses_parent",
        timeCreated: 100,
        timeUpdated: 100,
      })
      insertPart(dbPath, {
        id: "prt_task",
        sessionId: "ses_parent",
        timeCreated: startedAfterMs + 10,
        data: JSON.stringify({
          type: "tool",
          tool: "task",
          state: { status: "running", input: { command: "review" } },
        }),
      })
      expect(
        hasOpencodeTaskSubagentActivity(dbPath, "ses_parent", startedAfterMs),
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("detects a parent subtask part created after the turn started", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-startup-"))
    try {
      const dbPath = createFixtureDb(dir)
      const startedAfterMs = 1_000
      insertPart(dbPath, {
        id: "prt_subtask",
        sessionId: "ses_parent",
        timeCreated: startedAfterMs + 5,
        data: JSON.stringify({
          type: "subtask",
          command: "review",
          agent: "build",
        }),
      })
      expect(
        hasOpencodeTaskSubagentActivity(dbPath, "ses_parent", startedAfterMs),
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("observeOpencodeStartupActivity", () => {
  test("succeeds once a child session appears after the turn started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-startup-obs-"))
    try {
      const dbPath = createFixtureDb(dir)
      const startedAfterMs = Date.now()
      insertSession(dbPath, {
        id: "ses_parent",
        timeCreated: startedAfterMs - 10_000,
        timeUpdated: startedAfterMs - 10_000,
      })

      const observe = observeOpencodeStartupActivity({
        sessionId: "ses_parent",
        startedAfterMs,
        resolveDbPath: () => dbPath,
        pollInterval: Duration.millis(30),
      })

      // Seed the child shortly after the poller starts.
      const seed = Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(40))
        insertSession(dbPath, {
          id: "ses_child_live",
          parentId: "ses_parent",
          timeCreated: Date.now(),
          timeUpdated: Date.now(),
        })
      })

      await Effect.runPromise(
        Effect.all([observe, seed], { concurrency: 2 }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(2),
            orElse: () =>
              Effect.die(new Error("observeOpencodeStartupActivity timed out")),
          }),
        ),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
