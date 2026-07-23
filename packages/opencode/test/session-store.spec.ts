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

const createFixtureDb = (dir: string): string => {
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
})
