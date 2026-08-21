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

const getTail = (input: {
  readonly codexHome: string
  readonly sessionId: string
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* CodexSessionStore
      return yield* store.getTail(input.sessionId)
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

describe("CodexSessionStore Agent Turn Tail", () => {
  it("reads the latest Agent Turn without tool payloads", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-tail-"))
    try {
      const sessionId = "tail-latest-turn"
      const payloadMarker = "HUGE_TOOL_OUTPUT_SHOULD_NOT_APPEAR"
      writeScannedRollout({
        codexHome,
        partition: join("2026", "08", "18"),
        sessionId,
        raw: [
          JSON.stringify({
            timestamp: "2026-08-18T12:00:00.000Z",
            type: "session_meta",
            payload: { id: sessionId },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:01.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "old prompt" },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:02.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "old turn" },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:03.000Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "read",
              arguments: payloadMarker,
              call_id: "call_old",
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:03.100Z",
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "call_old",
              output: payloadMarker.repeat(200),
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:04.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "review the tests" },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:05.000Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "bun test",
              status: "failed",
              call_id: "call_new",
              input: payloadMarker,
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:05.100Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call_new",
              output: payloadMarker.repeat(200),
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:06.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "tests failed" },
          }),
        ].join("\n"),
      })

      const tail = await getTail({ codexHome, sessionId })
      expect(tail).toEqual({
        availability: "available",
        backend: { id: "codex", label: "Codex Build" },
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
      expect(JSON.stringify(tail)).not.toContain(payloadMarker)
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("returns an empty tail with jumpHint when the latest turn has no activity", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-tail-"))
    try {
      const sessionId = "tail-empty-turn"
      writeScannedRollout({
        codexHome,
        partition: join("2026", "08", "18"),
        sessionId,
        raw: [
          JSON.stringify({
            timestamp: "2026-08-18T12:00:00.000Z",
            type: "session_meta",
            payload: { id: sessionId },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:01.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "old prompt" },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:02.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "old turn" },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:03.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "new prompt" },
          }),
        ].join("\n"),
      })

      const tail = await getTail({ codexHome, sessionId })
      expect(tail.availability).toBe("available")
      expect(tail.items).toEqual([])
      expect(tail.jumpHint).toBe(true)
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("does not include child Session or inter-agent activity", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-tail-"))
    try {
      const sessionId = "tail-no-children"
      writeScannedRollout({
        codexHome,
        partition: join("2026", "08", "18"),
        sessionId,
        raw: [
          JSON.stringify({
            timestamp: "2026-08-18T12:00:00.000Z",
            type: "session_meta",
            payload: { id: sessionId },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:01.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "implement it" },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:02.000Z",
            type: "event_msg",
            payload: {
              type: "sub_agent_activity",
              kind: "started",
              agent_thread_id: "child-session",
              agent_path: "/root/spec_review",
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:03.000Z",
            type: "response_item",
            payload: {
              type: "agent_message",
              content: [
                {
                  type: "input_text",
                  text: "Message Type: NEW_TASK\nTask name: /root/spec_review",
                },
              ],
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:04.000Z",
            type: "response_item",
            payload: {
              type: "reasoning",
              summary: [{ text: "thinking about child work" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:05.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "parent progress" },
          }),
        ].join("\n"),
      })

      const tail = await getTail({ codexHome, sessionId })
      expect(tail).toEqual({
        availability: "available",
        backend: { id: "codex", label: "Codex Build" },
        jumpHint: false,
        items: [
          {
            kind: "assistant_text",
            text: "parent progress",
            truncated: false,
            at: "2026-08-18T12:00:05.000Z",
          },
        ],
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("keeps only the last 20 activity items and truncates assistant text at 2k", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-tail-"))
    try {
      const sessionId = "tail-bounds"
      const longText = `${"a".repeat(2000)}EXTRA`
      const lines = [
        JSON.stringify({
          timestamp: "2026-08-18T12:00:00.000Z",
          type: "session_meta",
          payload: { id: sessionId },
        }),
        JSON.stringify({
          timestamp: "2026-08-18T12:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "go" },
        }),
      ]
      for (let index = 1; index <= 25; index += 1) {
        lines.push(
          JSON.stringify({
            timestamp: `2026-08-18T12:00:${String(index + 1).padStart(2, "0")}.000Z`,
            type: "response_item",
            payload: {
              type: "function_call",
              name: `tool-${index}`,
              call_id: `call_${index}`,
            },
          }),
        )
      }
      lines.push(
        JSON.stringify({
          timestamp: "2026-08-18T12:00:28.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: longText },
        }),
      )
      writeScannedRollout({
        codexHome,
        partition: join("2026", "08", "18"),
        sessionId,
        raw: lines.join("\n"),
      })

      const tail = await getTail({ codexHome, sessionId })
      expect(tail.items).toHaveLength(20)
      expect(tail.items[0]).toEqual({
        kind: "tool",
        name: "tool-7",
        status: "unknown",
        at: "2026-08-18T12:00:08.000Z",
      })
      expect(tail.items[19]).toEqual({
        kind: "assistant_text",
        text: "a".repeat(2000),
        truncated: true,
        at: "2026-08-18T12:00:28.000Z",
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("does not treat a large tool call whose payload mentions user_message as a turn boundary", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-tail-"))
    try {
      const sessionId = "tail-large-tool"
      const input = `user_message ${"x".repeat(20_000)}`
      writeScannedRollout({
        codexHome,
        partition: join("2026", "08", "18"),
        sessionId,
        raw: [
          JSON.stringify({
            timestamp: "2026-08-18T12:00:00.000Z",
            type: "session_meta",
            payload: { id: sessionId },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:01.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "apply the patch" },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:02.000Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "apply_patch",
              status: "completed",
              call_id: "call_patch",
              input,
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:03.000Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call_patch",
              output: `user_message ${"y".repeat(40_000)}`,
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:04.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "patched" },
          }),
        ].join("\n"),
      })

      const tail = await getTail({ codexHome, sessionId })
      expect(tail).toEqual({
        availability: "available",
        backend: { id: "codex", label: "Codex Build" },
        jumpHint: false,
        items: [
          {
            kind: "tool",
            name: "apply_patch",
            status: "completed",
            at: "2026-08-18T12:00:02.000Z",
          },
          {
            kind: "assistant_text",
            text: "patched",
            truncated: false,
            at: "2026-08-18T12:00:04.000Z",
          },
        ],
      })
      expect(JSON.stringify(tail)).not.toContain("x".repeat(100))
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("classifies turn boundaries and tools from payload type, not payload text", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-tail-"))
    try {
      const sessionId = "tail-payload-type"
      const longAssistant = `mentions user_message ${"a".repeat(2500)}`
      writeScannedRollout({
        codexHome,
        partition: join("2026", "08", "18"),
        sessionId,
        raw: [
          JSON.stringify({
            timestamp: "2026-08-18T12:00:00.000Z",
            type: "session_meta",
            payload: { id: sessionId },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:01.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "old prompt" },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:02.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "old turn" },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:03.000Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "what is function_call_output",
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:04.000Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "apply_patch",
              status: "completed",
              call_id: "call_patch",
              input: `agent_message ${"z".repeat(20_000)}`,
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:05.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: longAssistant },
          }),
        ].join("\n"),
      })

      const tail = await getTail({ codexHome, sessionId })
      expect(tail.availability).toBe("available")
      expect(tail.jumpHint).toBe(false)
      expect(tail.items).toEqual([
        {
          kind: "tool",
          name: "apply_patch",
          status: "completed",
          at: "2026-08-18T12:00:04.000Z",
        },
        {
          kind: "assistant_text",
          text: longAssistant.slice(0, 2000),
          truncated: true,
          at: "2026-08-18T12:00:05.000Z",
        },
      ])
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("reads an indexed rollout tail and rejects unsafe Session IDs as MISSING", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-tail-"))
    try {
      const sessionId = "indexed-tail-session"
      const rolloutPath = writeScannedRollout({
        codexHome,
        partition: join("2026", "08", "18"),
        sessionId,
        raw: [
          JSON.stringify({
            timestamp: "2026-08-18T12:00:00.000Z",
            type: "session_meta",
            payload: { id: sessionId },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:01.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "go" },
          }),
          JSON.stringify({
            timestamp: "2026-08-18T12:00:02.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "working" },
          }),
        ].join("\n"),
      })
      writeThreadsIndex({
        codexHome,
        sessionId,
        rolloutPath,
      })

      await expect(getTail({ codexHome, sessionId })).resolves.toEqual({
        availability: "available",
        backend: { id: "codex", label: "Codex Build" },
        jumpHint: false,
        items: [
          {
            kind: "assistant_text",
            text: "working",
            truncated: false,
            at: "2026-08-18T12:00:02.000Z",
          },
        ],
      })
      await expect(
        getTail({ codexHome, sessionId: "../escape" }),
      ).resolves.toMatchObject({
        availability: "missing",
        backend: { id: "codex", label: "Codex Build" },
        items: [],
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("reads a tail when session metadata exceeds the bounded identity peek", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-tail-"))
    try {
      const sessionId = "large-session-metadata"
      writeScannedRollout({
        codexHome,
        partition: join("2026", "08", "21"),
        sessionId,
        raw: [
          JSON.stringify({
            timestamp: "2026-08-21T01:45:35.450Z",
            type: "session_meta",
            payload: {
              session_id: "parent-session",
              id: sessionId,
              base_instructions: { text: "x".repeat(20_000) },
            },
          }),
          JSON.stringify({
            timestamp: "2026-08-21T01:45:36.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "go" },
          }),
          JSON.stringify({
            timestamp: "2026-08-21T01:45:37.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "working" },
          }),
        ].join("\n"),
      })

      await expect(getTail({ codexHome, sessionId })).resolves.toMatchObject({
        availability: "available",
        items: [{ kind: "assistant_text", text: "working" }],
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("returns MISSING when the Codex Session record is absent", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-tail-"))
    try {
      mkdirSync(join(codexHome, "sessions"), { recursive: true })
      await expect(
        getTail({ codexHome, sessionId: "no-such-session" }),
      ).resolves.toMatchObject({
        availability: "missing",
        backend: { id: "codex", label: "Codex Build" },
        items: [],
        jumpHint: false,
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("returns UNAVAILABLE when the Codex Session record is unreadable", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-session-tail-"))
    try {
      writeScannedRollout({
        codexHome,
        partition: join("2026", "08", "18"),
        sessionId: "corrupt-tail-session",
        raw: "not-json\n",
      })
      await expect(
        getTail({ codexHome, sessionId: "corrupt-tail-session" }),
      ).resolves.toMatchObject({
        availability: "unavailable",
        backend: { id: "codex", label: "Codex Build" },
        items: [],
        jumpHint: false,
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })
})
