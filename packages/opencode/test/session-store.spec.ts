import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import {
  OpencodeSessionStore,
  OpencodeSessionStoreLive,
} from "../src/lib/session-store.js"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"

const createEmptySessionDb = (dir: string): string => {
  const path = join(dir, "opencode.db")
  const db = new Database(path)
  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY,
      model text,
      cost real DEFAULT 0 NOT NULL,
      tokens_input integer DEFAULT 0 NOT NULL,
      tokens_output integer DEFAULT 0 NOT NULL,
      tokens_reasoning integer DEFAULT 0 NOT NULL,
      tokens_cache_read integer DEFAULT 0 NOT NULL,
      tokens_cache_write integer DEFAULT 0 NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    )
  `)
  db.close()
  return path
}

const createMessagePartTables = (db: Database): void => {
  db.exec(`
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      data text NOT NULL,
      time_created integer NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      message_id text NOT NULL,
      data text NOT NULL,
      time_created integer NOT NULL
    );
  `)
}

const insertMessage = (
  db: Database,
  row: {
    readonly id: string
    readonly role: string
    readonly timeCreated: number
  },
): void => {
  db.query(
    `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`,
  ).run(
    row.id,
    "ses_fixture",
    JSON.stringify({ role: row.role }),
    row.timeCreated,
  )
}

const insertPart = (
  db: Database,
  row: {
    readonly id: string
    readonly messageId: string
    readonly data: unknown
    readonly timeCreated: number
  },
): void => {
  db.query(
    `INSERT INTO part (id, session_id, message_id, data, time_created)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    "ses_fixture",
    row.messageId,
    JSON.stringify(row.data),
    row.timeCreated,
  )
}

const createTailFixtureDb = (dir: string): string => {
  const path = createFixtureDb(dir)
  const db = new Database(path)
  createMessagePartTables(db)
  insertMessage(db, {
    id: "msg_user_1",
    role: "user",
    timeCreated: Date.parse("2026-08-18T12:00:01.000Z"),
  })
  insertMessage(db, {
    id: "msg_asst_1",
    role: "assistant",
    timeCreated: Date.parse("2026-08-18T12:00:02.000Z"),
  })
  insertPart(db, {
    id: "part_old_text",
    messageId: "msg_asst_1",
    data: { type: "text", text: "old turn" },
    timeCreated: Date.parse("2026-08-18T12:00:02.000Z"),
  })
  insertPart(db, {
    id: "part_old_tool",
    messageId: "msg_asst_1",
    data: {
      type: "tool",
      tool: "read",
      state: { status: "completed", output: "huge payload" },
    },
    timeCreated: Date.parse("2026-08-18T12:00:03.000Z"),
  })
  insertMessage(db, {
    id: "msg_user_2",
    role: "user",
    timeCreated: Date.parse("2026-08-18T12:00:04.000Z"),
  })
  insertMessage(db, {
    id: "msg_asst_2",
    role: "assistant",
    timeCreated: Date.parse("2026-08-18T12:00:05.000Z"),
  })
  insertPart(db, {
    id: "part_new_tool",
    messageId: "msg_asst_2",
    data: {
      type: "tool",
      tool: "bun test",
      state: { status: "failed", output: "x".repeat(50_000) },
    },
    timeCreated: Date.parse("2026-08-18T12:00:05.000Z"),
  })
  insertPart(db, {
    id: "part_new_text",
    messageId: "msg_asst_2",
    data: { type: "text", text: "tests failed" },
    timeCreated: Date.parse("2026-08-18T12:00:06.000Z"),
  })
  db.close()
  return path
}

const createEmptyTurnFixtureDb = (dir: string): string => {
  const path = createFixtureDb(dir)
  const db = new Database(path)
  createMessagePartTables(db)
  insertMessage(db, {
    id: "msg_user_1",
    role: "user",
    timeCreated: Date.parse("2026-08-18T12:00:01.000Z"),
  })
  insertMessage(db, {
    id: "msg_asst_1",
    role: "assistant",
    timeCreated: Date.parse("2026-08-18T12:00:02.000Z"),
  })
  insertPart(db, {
    id: "part_old_text",
    messageId: "msg_asst_1",
    data: { type: "text", text: "done" },
    timeCreated: Date.parse("2026-08-18T12:00:02.000Z"),
  })
  insertMessage(db, {
    id: "msg_user_2",
    role: "user",
    timeCreated: Date.parse("2026-08-18T12:00:03.000Z"),
  })
  db.close()
  return path
}

const createFixtureDb = (dir: string): string => {
  const path = createEmptySessionDb(dir)
  const db = new Database(path)
  db.query(
    `INSERT INTO session (
       id, model, cost, tokens_input, tokens_output, tokens_reasoning,
       tokens_cache_read, tokens_cache_write, time_created, time_updated
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "ses_fixture",
    JSON.stringify({
      id: "gpt-5.5",
      providerID: "openai",
      variant: "xhigh",
    }),
    1.25,
    100,
    20,
    5,
    50,
    10,
    Date.parse("2026-07-14T08:00:00.000Z"),
    Date.parse("2026-07-14T09:00:00.000Z"),
  )
  db.close()
  return path
}

describe("OpencodeSessionStore", () => {
  test("reads AVAILABLE session usage from fixture db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-session-"))
    try {
      const dbPath = createFixtureDb(dir)
      const runtime = ManagedRuntime.make(OpencodeSessionStoreLive({ dbPath }))
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* OpencodeSessionStore
          return yield* store.getSession("ses_fixture")
        }),
      )
      await runtime.dispose()
      expect(session).toEqual({
        id: "ses_fixture",
        availability: "available",
        model: {
          providerId: "openai",
          id: "gpt-5.5",
          variant: "xhigh",
        },
        tokens: {
          input: 100,
          output: 20,
          reasoning: 5,
          cacheRead: 50,
          cacheWrite: 10,
        },
        cost: 1.25,
        createdAt: "2026-07-14T08:00:00.000Z",
        updatedAt: "2026-07-14T09:00:00.000Z",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns MISSING when session row is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-session-"))
    try {
      const dbPath = createFixtureDb(dir)
      const runtime = ManagedRuntime.make(OpencodeSessionStoreLive({ dbPath }))
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* OpencodeSessionStore
          return yield* store.getSession("ses_gone")
        }),
      )
      await runtime.dispose()
      expect(session.availability).toBe("missing")
      expect(session.model).toBeNull()
      expect(session.tokens).toBeNull()
      expect(session.cost).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns UNAVAILABLE when database file is absent", async () => {
    const runtime = ManagedRuntime.make(
      OpencodeSessionStoreLive({
        dbPath: join(tmpdir(), "no-such-opencode-db.sqlite"),
      }),
    )
    const session = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* OpencodeSessionStore
        return yield* store.getSession("ses_any")
      }),
    )
    await runtime.dispose()
    expect(session.availability).toBe("unavailable")
    expect(session.model).toBeNull()
    expect(session.tokens).toBeNull()
    expect(session.cost).toBeNull()
  })

  test("OPENCODE_DB fallback reports MISSING when the CLI cannot resolve the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-session-"))
    try {
      const dbPath = createEmptySessionDb(dir)
      const runtime = ManagedRuntime.make(
        OpencodeSessionStoreLive({
          pathInput: {
            binary: join(dir, "no-such-opencode"),
            env: { OPENCODE_DB: dbPath, HOME: dir },
          },
        }),
      )
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* OpencodeSessionStore
          return yield* store.getSession("ses_e2e_fixture_missing")
        }),
      )
      await runtime.dispose()
      expect(session.availability).toBe("missing")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("reads the latest Agent Turn Tail without tool payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-session-"))
    try {
      const dbPath = createTailFixtureDb(dir)
      const runtime = ManagedRuntime.make(OpencodeSessionStoreLive({ dbPath }))
      const tail = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* OpencodeSessionStore
          return yield* store.getTail("ses_fixture")
        }),
      )
      await runtime.dispose()
      expect(tail).toEqual({
        availability: "available",
        backend: { id: "opencode", label: "OpenCode" },
        jumpHint: false,
        items: [
          {
            kind: "tool",
            name: "bun test",
            status: "failed",
            at: "2026-08-18T12:00:05.000Z",
          },
          {
            kind: "assistant_text",
            text: "tests failed",
            truncated: false,
            at: "2026-08-18T12:00:06.000Z",
          },
        ],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns empty tail with jumpHint when the latest turn has no activity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-session-"))
    try {
      const dbPath = createEmptyTurnFixtureDb(dir)
      const runtime = ManagedRuntime.make(OpencodeSessionStoreLive({ dbPath }))
      const tail = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* OpencodeSessionStore
          return yield* store.getTail("ses_fixture")
        }),
      )
      await runtime.dispose()
      expect(tail.availability).toBe("available")
      expect(tail.items).toEqual([])
      expect(tail.jumpHint).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
