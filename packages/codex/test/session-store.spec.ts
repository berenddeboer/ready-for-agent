import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  CodexSessionStore,
  CodexSessionStoreLive,
  resolveCodexHome,
} from "../src/lib/session-store.js"
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"

const getSession = (input: {
  readonly codexHome: string
  readonly sessionId: string
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* CodexSessionStore
      return yield* store.getSession(input.sessionId)
    }).pipe(
      Effect.provide(CodexSessionStoreLive({ codexHome: input.codexHome })),
    ),
  )

const writeScannedRollout = (input: {
  readonly codexHome: string
  readonly partition: string
  readonly sessionId: string
  readonly raw: string
}): string => {
  const directory = join(input.codexHome, "sessions", input.partition)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `rollout-fixture-${input.sessionId}.jsonl`)
  writeFileSync(path, input.raw)
  return path
}

describe("CodexSessionStore", () => {
  it("uses the Codex threads index for rollout location and timestamps", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      const sessionId = "019facd3-a591-7741-a8db-ec265acb19d7"
      const rolloutPath = join(codexHome, "sessions", "indexed-rollout.jsonl")
      mkdirSync(join(rolloutPath, ".."), { recursive: true })
      writeFileSync(
        rolloutPath,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId },
        })}\n`,
      )

      const db = new Database(join(codexHome, "state_5.sqlite"))
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.query(
        "INSERT INTO threads (id, rollout_path, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run(
        sessionId,
        rolloutPath,
        Date.parse("2026-08-08T02:00:00.000Z") / 1000,
        Date.parse("2026-08-08T03:00:00.000Z") / 1000,
      )
      db.close()

      await expect(getSession({ codexHome, sessionId })).resolves.toEqual({
        id: sessionId,
        availability: "available",
        model: null,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        cost: null,
        createdAt: "2026-08-08T02:00:00.000Z",
        updatedAt: "2026-08-08T03:00:00.000Z",
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("does not follow indexed rollout symlinks outside the sessions tree", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    const outsideDirectory = mkdtempSync(
      join(tmpdir(), "codex-session-store-outside-"),
    )
    try {
      const sessionId = "external-symlink-session"
      const sessionsRoot = join(codexHome, "sessions")
      const outsideRollout = join(outsideDirectory, "rollout.jsonl")
      const indexedPath = join(sessionsRoot, "indexed-rollout.jsonl")
      mkdirSync(sessionsRoot)
      writeFileSync(
        outsideRollout,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId },
        })}\n`,
      )
      symlinkSync(outsideRollout, indexedPath)

      const db = new Database(join(codexHome, "state_5.sqlite"))
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.query(
        "INSERT INTO threads (id, rollout_path, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).run(sessionId, indexedPath, 0, 0)
      db.close()

      await expect(getSession({ codexHome, sessionId })).resolves.toMatchObject(
        {
          id: sessionId,
          availability: "missing",
        },
      )
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
      rmSync(outsideDirectory, { recursive: true, force: true })
    }
  })

  it("returns missing for absent and unsafe Session IDs", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      mkdirSync(join(codexHome, "sessions"))
      await expect(
        getSession({ codexHome, sessionId: "missing-session" }),
      ).resolves.toMatchObject({
        id: "missing-session",
        availability: "missing",
        model: null,
        tokens: null,
      })
      await expect(
        getSession({ codexHome, sessionId: "../outside" }),
      ).resolves.toMatchObject({
        id: "../outside",
        availability: "missing",
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("keeps an established older rollout available with zero totals", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      const sessionId = "older-session"
      writeScannedRollout({
        codexHome,
        partition: join("2025", "01", "02"),
        sessionId,
        raw: [
          "not-json",
          JSON.stringify({
            timestamp: "2025-01-02T03:04:05Z",
            type: "session_meta",
            payload: { id: sessionId },
          }),
          '{"type":"event_msg"',
        ].join("\n"),
      })

      await expect(getSession({ codexHome, sessionId })).resolves.toEqual({
        id: sessionId,
        availability: "available",
        model: null,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        cost: null,
        createdAt: "2025-01-02T03:04:05.000Z",
        updatedAt: "2025-01-02T03:04:05.000Z",
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("returns unavailable for corrupt identity or ambiguous rollouts", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      writeScannedRollout({
        codexHome,
        partition: join("2026", "01", "01"),
        sessionId: "corrupt-session",
        raw: "not-json\n",
      })
      await expect(
        getSession({ codexHome, sessionId: "corrupt-session" }),
      ).resolves.toMatchObject({ availability: "unavailable" })

      for (const day of ["02", "03"]) {
        writeScannedRollout({
          codexHome,
          partition: join("2026", "01", day),
          sessionId: "duplicate-session",
          raw: `${JSON.stringify({
            type: "session_meta",
            payload: { id: "duplicate-session" },
          })}\n`,
        })
      }
      await expect(
        getSession({ codexHome, sessionId: "duplicate-session" }),
      ).resolves.toMatchObject({ availability: "unavailable" })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("resolves explicit and environment-provided Codex homes", () => {
    expect(
      resolveCodexHome({
        codexHome: "/explicit/codex",
        env: { CODEX_HOME: "/env/codex", HOME: "/home/test" },
      }),
    ).toBe("/explicit/codex")
    expect(resolveCodexHome({ env: { CODEX_HOME: "/env/codex" } })).toBe(
      "/env/codex",
    )
    expect(resolveCodexHome({ env: { HOME: "/home/test" } })).toBe(
      "/home/test/.codex",
    )
  })
})
