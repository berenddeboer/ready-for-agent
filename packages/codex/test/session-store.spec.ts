import {
  chmodSync,
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
  findCodexSessionRollout,
  foldCodexRollout,
  isSafeCodexSessionIdSegment,
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

const writeThreadsIndex = (input: {
  readonly codexHome: string
  readonly sessionId: string
  readonly rolloutPath: string
  readonly createdAt?: number
  readonly updatedAt?: number
}): void => {
  const db = new Database(join(input.codexHome, "state_5.sqlite"))
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.query(
    "INSERT OR REPLACE INTO threads (id, rollout_path, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(
    input.sessionId,
    input.rolloutPath,
    input.createdAt ?? 0,
    input.updatedAt ?? 0,
  )
  db.close()
}

const tokenCountLine = (input: {
  readonly timestamp: string
  readonly total: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  readonly last?: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
}) => ({
  timestamp: input.timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      ...(input.last === undefined
        ? {}
        : {
            last_token_usage: {
              input_tokens: input.last.input,
              output_tokens: input.last.output,
              reasoning_output_tokens: input.last.reasoning,
              cached_input_tokens: input.last.cacheRead,
              cache_write_input_tokens: input.last.cacheWrite,
            },
          }),
      total_token_usage: {
        input_tokens: input.total.input,
        output_tokens: input.total.output,
        reasoning_output_tokens: input.total.reasoning,
        cached_input_tokens: input.total.cacheRead,
        cache_write_input_tokens: input.total.cacheWrite,
      },
    },
  },
})

describe("isSafeCodexSessionIdSegment", () => {
  it("accepts opaque single-segment Session IDs and rejects path escapes", () => {
    expect(
      isSafeCodexSessionIdSegment("019fab2c-9466-7432-ad16-9de23f94f2db"),
    ).toBe(true)
    expect(isSafeCodexSessionIdSegment("abc..def")).toBe(true)
    for (const id of [
      "",
      ".",
      "..",
      "../outside",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "\0null",
    ]) {
      expect(isSafeCodexSessionIdSegment(id)).toBe(false)
    }
  })
})

describe("foldCodexRollout", () => {
  it("uses only the last total_token_usage and never sums last_token_usage", () => {
    const fold = foldCodexRollout(
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "session-last-wins" },
        }),
        JSON.stringify(
          tokenCountLine({
            timestamp: "2026-08-08T01:00:00.000Z",
            total: {
              input: 100,
              output: 20,
              reasoning: 5,
              cacheRead: 60,
              cacheWrite: 7,
            },
          }),
        ),
        JSON.stringify(
          tokenCountLine({
            timestamp: "2026-08-08T01:01:00.000Z",
            last: {
              input: 50,
              output: 10,
              reasoning: 2,
              cacheRead: 30,
              cacheWrite: 3,
            },
            total: {
              input: 250,
              output: 45,
              reasoning: 11,
              cacheRead: 140,
              cacheWrite: 13,
            },
          }),
        ),
      ].join("\n"),
    )

    expect(fold.sessionId).toBe("session-last-wins")
    expect(fold.tokens).toEqual({
      input: 250,
      output: 45,
      reasoning: 11,
      cacheRead: 140,
      cacheWrite: 13,
    })
  })
})

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

      writeThreadsIndex({
        codexHome,
        sessionId,
        rolloutPath,
        createdAt: Date.parse("2026-08-08T02:00:00.000Z") / 1000,
        updatedAt: Date.parse("2026-08-08T03:00:00.000Z") / 1000,
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
        createdAt: "2026-08-08T02:00:00.000Z",
        updatedAt: "2026-08-08T03:00:00.000Z",
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("falls back to the sessions tree when the threads index is missing", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      const sessionId = "scan-only-session"
      writeScannedRollout({
        codexHome,
        partition: join("2026", "02", "01"),
        sessionId,
        raw: `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId },
        })}\n`,
      })

      await expect(getSession({ codexHome, sessionId })).resolves.toMatchObject(
        {
          id: sessionId,
          availability: "available",
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      )
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("falls back to a unique scanned rollout when the index path is stale", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      const sessionId = "stale-index-session"
      const sessionsRoot = join(codexHome, "sessions")
      mkdirSync(sessionsRoot, { recursive: true })
      // Index points at a path that no longer exists; findIndexedRollout skips it.
      writeThreadsIndex({
        codexHome,
        sessionId,
        rolloutPath: join(sessionsRoot, "gone-rollout.jsonl"),
      })
      writeScannedRollout({
        codexHome,
        partition: join("2026", "03", "01"),
        sessionId,
        raw: `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId },
        })}\n`,
      })

      await expect(getSession({ codexHome, sessionId })).resolves.toMatchObject(
        {
          id: sessionId,
          availability: "available",
        },
      )
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("falls back to a unique scanned rollout when the index path is for another Session", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      const sessionId = "wanted-session"
      const sessionsRoot = join(codexHome, "sessions")
      mkdirSync(sessionsRoot, { recursive: true })
      const wrongPath = join(sessionsRoot, "wrong-session.jsonl")
      writeFileSync(
        wrongPath,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: "other-session" },
        })}\n`,
      )
      writeThreadsIndex({
        codexHome,
        sessionId,
        rolloutPath: wrongPath,
      })
      writeScannedRollout({
        codexHome,
        partition: join("2026", "03", "02"),
        sessionId,
        raw: [
          JSON.stringify({
            type: "session_meta",
            payload: { id: sessionId },
          }),
          JSON.stringify(
            tokenCountLine({
              timestamp: "2026-08-08T04:00:00.000Z",
              total: {
                input: 9,
                output: 4,
                reasoning: 1,
                cacheRead: 2,
                cacheWrite: 0,
              },
            }),
          ),
        ].join("\n"),
      })

      await expect(getSession({ codexHome, sessionId })).resolves.toEqual({
        id: sessionId,
        availability: "available",
        model: null,
        tokens: {
          input: 9,
          output: 4,
          reasoning: 1,
          cacheRead: 2,
          cacheWrite: 0,
        },
        cost: null,
        createdAt: "2026-08-08T04:00:00.000Z",
        updatedAt: "2026-08-08T04:00:00.000Z",
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("returns MISSING when the index points at another Session and no rollout matches", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      const sessionId = "wanted-absent"
      const sessionsRoot = join(codexHome, "sessions")
      mkdirSync(sessionsRoot, { recursive: true })
      const wrongPath = join(sessionsRoot, "other-only.jsonl")
      writeFileSync(
        wrongPath,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: "other-session" },
        })}\n`,
      )
      writeThreadsIndex({
        codexHome,
        sessionId,
        rolloutPath: wrongPath,
      })

      await expect(getSession({ codexHome, sessionId })).resolves.toEqual({
        id: sessionId,
        availability: "missing",
        model: null,
        tokens: null,
        cost: null,
        createdAt: null,
        updatedAt: null,
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("returns UNAVAILABLE when a scan-pattern rollout has mismatched identity (index or scan)", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      const sessionId = "name-claims-id"
      const mismatched = `${JSON.stringify({
        type: "session_meta",
        payload: { id: "actually-other-session" },
      })}\n`

      // Pure scan: filename claims sessionId but session_meta does not.
      writeScannedRollout({
        codexHome,
        partition: join("2026", "03", "03"),
        sessionId,
        raw: mismatched,
      })
      await expect(getSession({ codexHome, sessionId })).resolves.toMatchObject(
        {
          id: sessionId,
          availability: "unavailable",
          tokens: null,
        },
      )

      // Same unusable file reached only via the threads index must not flip to
      // MISSING (availability must match the pure-scan outcome above).
      const codexHomeIndexed = mkdtempSync(
        join(tmpdir(), "codex-session-store-indexed-"),
      )
      try {
        const sessionsRoot = join(codexHomeIndexed, "sessions")
        mkdirSync(sessionsRoot, { recursive: true })
        const indexedPath = join(
          sessionsRoot,
          `rollout-indexed-${sessionId}.jsonl`,
        )
        writeFileSync(indexedPath, mismatched)
        writeThreadsIndex({
          codexHome: codexHomeIndexed,
          sessionId,
          rolloutPath: indexedPath,
        })
        await expect(
          getSession({ codexHome: codexHomeIndexed, sessionId }),
        ).resolves.toMatchObject({
          id: sessionId,
          availability: "unavailable",
          tokens: null,
        })
      } finally {
        rmSync(codexHomeIndexed, { recursive: true, force: true })
      }
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("falls back to scan when the threads schema is mismatched", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      const sessionId = "schema-mismatch-session"
      const db = new Database(join(codexHome, "state_5.sqlite"))
      db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, notes TEXT)`)
      db.query("INSERT INTO threads (id, notes) VALUES (?, ?)").run(
        sessionId,
        "no rollout path column",
      )
      db.close()
      writeScannedRollout({
        codexHome,
        partition: join("2026", "04", "01"),
        sessionId,
        raw: `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId },
        })}\n`,
      })

      await expect(getSession({ codexHome, sessionId })).resolves.toMatchObject(
        {
          id: sessionId,
          availability: "available",
        },
      )
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

      writeThreadsIndex({
        codexHome,
        sessionId,
        rolloutPath: indexedPath,
      })

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

  it("returns MISSING for a safe Session ID with no matching Codex Session", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      mkdirSync(join(codexHome, "sessions"))
      await expect(
        getSession({ codexHome, sessionId: "missing-session" }),
      ).resolves.toEqual({
        id: "missing-session",
        availability: "missing",
        model: null,
        tokens: null,
        cost: null,
        createdAt: null,
        updatedAt: null,
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("rejects unsafe Session ID path segments without path escape as non-AVAILABLE", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      mkdirSync(join(codexHome, "sessions"), { recursive: true })
      // Plant a decoy outside the intended lookup to ensure no escape succeeds.
      const outside = join(codexHome, "escaped.jsonl")
      writeFileSync(
        outside,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: "escaped" },
        })}\n`,
      )

      for (const sessionId of ["", "..", "../escaped", "a/b", "/etc/passwd"]) {
        await expect(
          getSession({ codexHome, sessionId }),
        ).resolves.toMatchObject({
          id: sessionId.trim() === "" ? "" : sessionId.trim(),
          availability: "missing",
          tokens: null,
        })
        expect(findCodexSessionRollout({ codexHome, sessionId })).toEqual({
          kind: "missing",
        })
      }
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

  it("returns UNAVAILABLE for unusably corrupt Session data", async () => {
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
      ).resolves.toEqual({
        id: "corrupt-session",
        availability: "unavailable",
        model: null,
        tokens: null,
        cost: null,
        createdAt: null,
        updatedAt: null,
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("returns UNAVAILABLE when the uniquely indexed rollout is unreadable", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      const sessionId = "unreadable-indexed"
      const sessionsRoot = join(codexHome, "sessions")
      mkdirSync(sessionsRoot, { recursive: true })
      const rolloutPath = join(sessionsRoot, "locked-rollout.jsonl")
      writeFileSync(
        rolloutPath,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId },
        })}\n`,
      )
      chmodSync(rolloutPath, 0)
      writeThreadsIndex({
        codexHome,
        sessionId,
        rolloutPath,
      })

      await expect(getSession({ codexHome, sessionId })).resolves.toMatchObject(
        {
          id: sessionId,
          availability: "unavailable",
          tokens: null,
        },
      )
    } finally {
      try {
        chmodSync(join(codexHome, "sessions", "locked-rollout.jsonl"), 0o644)
      } catch {
        // Best-effort restore before recursive delete.
      }
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("returns UNAVAILABLE for ambiguous duplicate rollouts without unique index resolution", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
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
      ).resolves.toMatchObject({
        id: "duplicate-session",
        availability: "unavailable",
        tokens: null,
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("prefers a unique threads index hit even when filename suffix scan would be ambiguous", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-store-"))
    try {
      const sessionId = "indexed-unique-session"
      for (const day of ["04", "05"]) {
        writeScannedRollout({
          codexHome,
          partition: join("2026", "01", day),
          sessionId,
          raw: `${JSON.stringify({
            type: "session_meta",
            payload: { id: sessionId },
          })}\n`,
        })
      }
      const preferred = join(codexHome, "sessions", "preferred-rollout.jsonl")
      writeFileSync(
        preferred,
        [
          JSON.stringify({
            type: "session_meta",
            payload: { id: sessionId },
          }),
          JSON.stringify(
            tokenCountLine({
              timestamp: "2026-08-08T05:00:00.000Z",
              total: {
                input: 3,
                output: 1,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
            }),
          ),
        ].join("\n"),
      )
      writeThreadsIndex({
        codexHome,
        sessionId,
        rolloutPath: preferred,
      })

      await expect(getSession({ codexHome, sessionId })).resolves.toMatchObject(
        {
          id: sessionId,
          availability: "available",
          tokens: {
            input: 3,
            output: 1,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      )
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
