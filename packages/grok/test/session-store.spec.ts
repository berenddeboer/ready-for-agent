import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import {
  GROK_COST_USD_TICKS_PER_USD,
  GROK_SESSION_PROVIDER_ID,
  GrokSessionStore,
  GrokSessionStoreLive,
  accumulateTurnUsage,
  costUsdFromTicks,
  findGrokSessionDirectory,
  isSafeGrokSessionIdSegment,
  normalizeGrokTimestamp,
  sumTurnCompletedUsageFromJsonl,
} from "../src/lib/session-store.js"
import { describe, expect, test } from "bun:test"

const writeSessionFixture = (
  grokHome: string,
  cwdEncoded: string,
  sessionId: string,
  options: {
    readonly summary?: Record<string, unknown> | null
    readonly updatesJsonl?: string | null
  },
): string => {
  const sessionDir = join(grokHome, "sessions", cwdEncoded, sessionId)
  mkdirSync(sessionDir, { recursive: true })
  if (options.summary !== null && options.summary !== undefined) {
    writeFileSync(
      join(sessionDir, "summary.json"),
      `${JSON.stringify(options.summary, null, 2)}\n`,
    )
  }
  if (options.updatesJsonl !== null && options.updatesJsonl !== undefined) {
    writeFileSync(join(sessionDir, "updates.jsonl"), options.updatesJsonl)
  }
  return sessionDir
}

const turnCompletedLine = (usage: Record<string, unknown>): string =>
  JSON.stringify({
    timestamp: 1,
    method: "_x.ai/session/update",
    params: {
      sessionId: "ses_any",
      update: {
        sessionUpdate: "turn_completed",
        usage,
      },
    },
  })

const subagentFinishedLine = (tokensUsed: number): string =>
  JSON.stringify({
    timestamp: 2,
    method: "_x.ai/session/update",
    params: {
      sessionId: "ses_any",
      update: {
        sessionUpdate: "subagent_finished",
        tokens_used: tokensUsed,
      },
    },
  })

describe("Grok cost tick conversion", () => {
  test("converts costUsdTicks with 1 USD = 10^10 ticks", () => {
    expect(GROK_COST_USD_TICKS_PER_USD).toBe(10_000_000_000)
    expect(costUsdFromTicks(3907880000)).toBe(0.390788)
    expect(costUsdFromTicks(0)).toBe(0)
    expect(costUsdFromTicks(10_000_000_000)).toBe(1)
  })
})

describe("sumTurnCompletedUsageFromJsonl", () => {
  test("sums multiple turn_completed usage objects", () => {
    const jsonl = [
      turnCompletedLine({
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 5,
        cachedReadTokens: 40,
        costUsdTicks: 1_000_000_000,
      }),
      // Non-usage event ignored
      JSON.stringify({
        params: { update: { sessionUpdate: "agent_message_chunk" } },
      }),
      turnCompletedLine({
        inputTokens: 50,
        outputTokens: 20,
        reasoningTokens: 2,
        cachedReadTokens: 10,
        costUsdTicks: 500_000_000,
      }),
      // Corrupt line ignored
      "not-json",
      // subagent tokens must not double-count
      subagentFinishedLine(99999),
    ].join("\n")

    const usage = sumTurnCompletedUsageFromJsonl(jsonl)
    expect(usage).toEqual({
      input: 150,
      output: 30,
      reasoning: 7,
      cacheRead: 50,
      costTicks: 1_500_000_000,
    })
    expect(costUsdFromTicks(usage.costTicks)).toBe(0.15)
  })

  test("returns zeros when no turn_completed rows exist", () => {
    expect(sumTurnCompletedUsageFromJsonl("")).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      costTicks: 0,
    })
    expect(sumTurnCompletedUsageFromJsonl(subagentFinishedLine(111))).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      costTicks: 0,
    })
  })

  test("accumulateTurnUsage ignores non-objects", () => {
    const base = {
      input: 1,
      output: 2,
      reasoning: 3,
      cacheRead: 4,
      costTicks: 5,
    }
    expect(accumulateTurnUsage(base, null)).toEqual(base)
    expect(accumulateTurnUsage(base, "x")).toEqual(base)
  })
})

describe("normalizeGrokTimestamp", () => {
  test("truncates sub-ms ISO fractions", () => {
    expect(normalizeGrokTimestamp("2026-07-25T02:25:55.976154555Z")).toBe(
      "2026-07-25T02:25:55.976Z",
    )
    expect(normalizeGrokTimestamp(null)).toBeNull()
    expect(normalizeGrokTimestamp("")).toBeNull()
  })
})

describe("isSafeGrokSessionIdSegment", () => {
  test("accepts single-segment ids and rejects path escapes", () => {
    expect(isSafeGrokSessionIdSegment("ses_abc")).toBe(true)
    expect(
      isSafeGrokSessionIdSegment("019faaf2-50b3-7873-9158-a2c3d7f183cb"),
    ).toBe(true)
    expect(isSafeGrokSessionIdSegment("")).toBe(false)
    expect(isSafeGrokSessionIdSegment(".")).toBe(false)
    expect(isSafeGrokSessionIdSegment("..")).toBe(false)
    expect(isSafeGrokSessionIdSegment("/etc")).toBe(false)
    expect(isSafeGrokSessionIdSegment("../secret")).toBe(false)
    expect(isSafeGrokSessionIdSegment("a/b")).toBe(false)
    expect(isSafeGrokSessionIdSegment("a\\b")).toBe(false)
  })
})

describe("findGrokSessionDirectory", () => {
  test("finds session under encoded cwd segment", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-home-"))
    try {
      writeSessionFixture(dir, "%2Ftmp%2Fproj", "ses_abc", {
        summary: { current_model_id: "grok-4.5" },
        updatesJsonl: "",
      })
      expect(findGrokSessionDirectory(dir, "ses_abc")).toEqual({
        kind: "found",
        path: join(dir, "sessions", "%2Ftmp%2Fproj", "ses_abc"),
      })
      expect(findGrokSessionDirectory(dir, "  ses_abc  ")).toEqual({
        kind: "found",
        path: join(dir, "sessions", "%2Ftmp%2Fproj", "ses_abc"),
      })
      expect(findGrokSessionDirectory(dir, "ses_missing")).toEqual({
        kind: "missing",
      })
      expect(findGrokSessionDirectory(dir, "/etc/passwd")).toEqual({
        kind: "missing",
      })
      expect(findGrokSessionDirectory(dir, "../escape")).toEqual({
        kind: "missing",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns unavailable when sessions root is not a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-home-"))
    try {
      writeFileSync(join(dir, "sessions"), "not-a-directory")
      expect(findGrokSessionDirectory(dir, "ses_any")).toEqual({
        kind: "unavailable",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("GrokSessionStore", () => {
  test("reads AVAILABLE session usage from fixture files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-session-"))
    try {
      writeSessionFixture(dir, "%2Fwork%2Frepo", "ses_fixture", {
        summary: {
          current_model_id: "grok-4.5",
          reasoning_effort: "medium",
          created_at: "2026-07-25T02:25:55.976154555Z",
          updated_at: "2026-07-25T02:26:07.451815208Z",
          last_active_at: "2026-07-25T02:26:07.451815208Z",
        },
        updatesJsonl: [
          turnCompletedLine({
            inputTokens: 631580,
            outputTokens: 471,
            totalTokens: 632051,
            cachedReadTokens: 629760,
            reasoningTokens: 224,
            costUsdTicks: 3907880000,
          }),
          turnCompletedLine({
            inputTokens: 100,
            outputTokens: 29,
            cachedReadTokens: 40,
            reasoningTokens: 6,
            costUsdTicks: 120000000,
          }),
          subagentFinishedLine(50000),
        ].join("\n"),
      })

      const runtime = ManagedRuntime.make(
        GrokSessionStoreLive({ grokHome: dir }),
      )
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* GrokSessionStore
          return yield* store.getSession("ses_fixture")
        }),
      )
      await runtime.dispose()

      expect(session).toEqual({
        id: "ses_fixture",
        availability: "available",
        model: {
          providerId: GROK_SESSION_PROVIDER_ID,
          id: "grok-4.5",
          thinkingLevel: "medium",
        },
        tokens: {
          input: 631680,
          output: 500,
          reasoning: 230,
          cacheRead: 629800,
          cacheWrite: 0,
        },
        cost: costUsdFromTicks(4027880000),
        createdAt: "2026-07-25T02:25:55.976Z",
        updatedAt: "2026-07-25T02:26:07.451Z",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns AVAILABLE with zeroed tokens when no turn_completed rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-session-"))
    try {
      writeSessionFixture(dir, "%2Fwork", "ses_empty", {
        summary: {
          current_model_id: "grok-4.5",
          created_at: "2026-07-25T00:00:00.000Z",
          last_active_at: "2026-07-25T00:00:01.000Z",
        },
        updatesJsonl: subagentFinishedLine(10),
      })

      const runtime = ManagedRuntime.make(
        GrokSessionStoreLive({ grokHome: dir }),
      )
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* GrokSessionStore
          return yield* store.getSession("ses_empty")
        }),
      )
      await runtime.dispose()

      expect(session.availability).toBe("available")
      expect(session.tokens).toEqual({
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })
      expect(session.cost).toBe(0)
      expect(session.model?.id).toBe("grok-4.5")
      // Falls back to last_active_at when updated_at is absent.
      expect(session.updatedAt).toBe("2026-07-25T00:00:01.000Z")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns MISSING when session directory is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-session-"))
    try {
      mkdirSync(join(dir, "sessions"), { recursive: true })
      const runtime = ManagedRuntime.make(
        GrokSessionStoreLive({ grokHome: dir }),
      )
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* GrokSessionStore
          return yield* store.getSession("ses_gone")
        }),
      )
      await runtime.dispose()
      expect(session.availability).toBe("missing")
      expect(session.tokens).toBeNull()
      expect(session.cost).toBeNull()
      expect(session.model).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns MISSING when summary.json is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-session-"))
    try {
      writeSessionFixture(dir, "%2Fwork", "ses_nosummary", {
        summary: null,
        updatesJsonl: turnCompletedLine({ inputTokens: 1 }),
      })
      const runtime = ManagedRuntime.make(
        GrokSessionStoreLive({ grokHome: dir }),
      )
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* GrokSessionStore
          return yield* store.getSession("ses_nosummary")
        }),
      )
      await runtime.dispose()
      expect(session.availability).toBe("missing")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns UNAVAILABLE when summary.json is corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-session-"))
    try {
      const sessionDir = join(dir, "sessions", "%2Fwork", "ses_bad")
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, "summary.json"), "{not-json")
      const runtime = ManagedRuntime.make(
        GrokSessionStoreLive({ grokHome: dir }),
      )
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* GrokSessionStore
          return yield* store.getSession("ses_bad")
        }),
      )
      await runtime.dispose()
      expect(session.availability).toBe("unavailable")
      expect(session.tokens).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns UNAVAILABLE when sessions root is unreadable as a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-session-"))
    try {
      writeFileSync(join(dir, "sessions"), "not-a-directory")
      const runtime = ManagedRuntime.make(
        GrokSessionStoreLive({ grokHome: dir }),
      )
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* GrokSessionStore
          return yield* store.getSession("ses_any")
        }),
      )
      await runtime.dispose()
      expect(session.availability).toBe("unavailable")
      expect(session.id).toBe("ses_any")
      expect(session.tokens).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("trims session id for lookup and returned id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-session-"))
    try {
      writeSessionFixture(dir, "%2Fwork", "ses_trim", {
        summary: {
          current_model_id: "grok-4.5",
          created_at: "2026-07-25T00:00:00.000Z",
          updated_at: "2026-07-25T00:00:01.000Z",
        },
        updatesJsonl: "",
      })
      const runtime = ManagedRuntime.make(
        GrokSessionStoreLive({ grokHome: dir }),
      )
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* GrokSessionStore
          return yield* store.getSession("  ses_trim  ")
        }),
      )
      await runtime.dispose()
      expect(session.availability).toBe("available")
      expect(session.id).toBe("ses_trim")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
