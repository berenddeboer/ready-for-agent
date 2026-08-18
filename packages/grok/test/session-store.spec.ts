import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import {
  AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX,
  AGENT_TURN_TAIL_ITEM_LIMIT,
} from "@ready-for-agent/agent-backend"
import {
  GROK_BACKEND,
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

const TS_USER_OLD = 1787000001
const TS_OLD_TEXT = 1787000002
const TS_OLD_TOOL = 1787000003
const TS_USER = 1787000004
const TS_TOOL = 1787000005
const TS_TEXT = 1787000006
const AT_TOOL = "2026-08-17T20:53:25.000Z"
const AT_TEXT = "2026-08-17T20:53:26.000Z"
const AT_TOOL_7 = "2026-08-17T20:53:31.000Z"
const SECRET_PAYLOAD = `SECRET_PAYLOAD_${"x".repeat(50_000)}`
const CHILD_SECRET = "CHILD_SESSION_SECRET_SHOULD_NOT_APPEAR"

const sessionUpdateLine = (
  timestamp: number,
  sessionId: string,
  update: Record<string, unknown>,
): string =>
  JSON.stringify({
    timestamp,
    method: "session/update",
    params: { sessionId, update },
  })

const userLine = (timestamp: number, sessionId: string, text: string): string =>
  sessionUpdateLine(timestamp, sessionId, {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
  })

const thoughtLine = (
  timestamp: number,
  sessionId: string,
  text: string,
): string =>
  sessionUpdateLine(timestamp, sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  })

const assistantLine = (
  timestamp: number,
  sessionId: string,
  text: string,
): string =>
  sessionUpdateLine(timestamp, sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  })

const toolCallLine = (
  timestamp: number,
  sessionId: string,
  toolCallId: string,
  name: string,
): string =>
  sessionUpdateLine(timestamp, sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: name,
    rawInput: { command: "should-not-appear" },
    _meta: {
      "x.ai/tool": {
        version: 1,
        name,
        kind: "execute",
        namespace: "grok_build",
        label: "Run Command",
        read_only: false,
      },
    },
  })

const toolUpdateLine = (
  timestamp: number,
  sessionId: string,
  toolCallId: string,
  status: string,
  output: string,
): string =>
  sessionUpdateLine(timestamp, sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status,
    rawOutput: { type: "Bash", output },
    content: [{ type: "content", content: { type: "text", text: output } }],
  })

const subagentFinishedLineForTail = (
  timestamp: number,
  sessionId: string,
): string =>
  sessionUpdateLine(timestamp, sessionId, {
    sessionUpdate: "subagent_finished",
    child_session_id: "ses_child",
    status: "completed",
    output: CHILD_SECRET,
  })

const getTail = async (grokHome: string, sessionId: string) => {
  const runtime = ManagedRuntime.make(GrokSessionStoreLive({ grokHome }))
  const tail = await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* GrokSessionStore
      return yield* store.getTail(sessionId)
    }),
  )
  await runtime.dispose()
  return tail
}

describe("GrokSessionStore.getTail", () => {
  test("reads the latest Agent Turn Tail without tool payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tail-"))
    try {
      writeSessionFixture(dir, "%2Fwork", "ses_fixture", {
        summary: { current_model_id: "grok-4.6" },
        updatesJsonl: [
          userLine(TS_USER_OLD, "ses_fixture", "old implement prompt"),
          thoughtLine(TS_OLD_TEXT, "ses_fixture", "thinking about old turn"),
          assistantLine(TS_OLD_TEXT, "ses_fixture", "old turn"),
          toolCallLine(TS_OLD_TOOL, "ses_fixture", "call_old", "read_file"),
          toolUpdateLine(
            TS_OLD_TOOL,
            "ses_fixture",
            "call_old",
            "completed",
            SECRET_PAYLOAD,
          ),
          userLine(TS_USER, "ses_fixture", "harness review prompt"),
          thoughtLine(TS_TOOL, "ses_fixture", "I will run tests"),
          toolCallLine(
            TS_TOOL,
            "ses_fixture",
            "call_new",
            "run_terminal_command",
          ),
          toolUpdateLine(
            TS_TOOL,
            "ses_fixture",
            "call_new",
            "failed",
            SECRET_PAYLOAD,
          ),
          assistantLine(TS_TEXT, "ses_fixture", "tests failed"),
          turnCompletedLine({ inputTokens: 10 }),
        ].join("\n"),
      })

      const tail = await getTail(dir, "ses_fixture")
      expect(tail).toEqual({
        availability: "available",
        backend: GROK_BACKEND,
        jumpHint: false,
        items: [
          {
            kind: "tool",
            name: "run_terminal_command",
            status: "failed",
            at: AT_TOOL,
          },
          {
            kind: "assistant_text",
            text: "tests failed",
            truncated: false,
            at: AT_TEXT,
          },
        ],
      })
      expect(JSON.stringify(tail)).not.toContain("SECRET_PAYLOAD")
      expect(JSON.stringify(tail)).not.toContain("should-not-appear")
      expect(JSON.stringify(tail)).not.toContain("old turn")
      expect(JSON.stringify(tail)).not.toContain("thinking")
      expect(JSON.stringify(tail)).not.toContain("harness review prompt")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns empty tail with jumpHint when the latest turn has no activity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tail-"))
    try {
      writeSessionFixture(dir, "%2Fwork", "ses_fixture", {
        summary: { current_model_id: "grok-4.6" },
        updatesJsonl: [
          userLine(TS_USER_OLD, "ses_fixture", "implement"),
          assistantLine(TS_OLD_TEXT, "ses_fixture", "done"),
          userLine(TS_USER, "ses_fixture", "review in children"),
          subagentFinishedLineForTail(TS_TEXT, "ses_fixture"),
        ].join("\n"),
      })

      const tail = await getTail(dir, "ses_fixture")
      expect(tail.availability).toBe("available")
      expect(tail.items).toEqual([])
      expect(tail.jumpHint).toBe(true)
      expect(JSON.stringify(tail)).not.toContain(CHILD_SECRET)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not include child Session activity recorded under another Session ID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tail-"))
    try {
      writeSessionFixture(dir, "%2Fwork", "ses_fixture", {
        summary: { current_model_id: "grok-4.6" },
        updatesJsonl: [
          userLine(TS_USER, "ses_fixture", "review"),
          toolCallLine(TS_TOOL, "ses_child", "call_child", "grep"),
          toolUpdateLine(
            TS_TOOL,
            "ses_child",
            "call_child",
            "completed",
            "hit",
          ),
          assistantLine(TS_TEXT, "ses_child", CHILD_SECRET),
        ].join("\n"),
      })
      writeSessionFixture(dir, "%2Fwork", "ses_child", {
        summary: { current_model_id: "grok-4.6" },
        updatesJsonl: [
          userLine(TS_USER, "ses_child", "child prompt"),
          assistantLine(TS_TEXT, "ses_child", CHILD_SECRET),
        ].join("\n"),
      })

      const tail = await getTail(dir, "ses_fixture")
      expect(tail.availability).toBe("available")
      expect(tail.items).toEqual([])
      expect(tail.jumpHint).toBe(true)
      expect(JSON.stringify(tail)).not.toContain(CHILD_SECRET)
      expect(JSON.stringify(tail)).not.toContain("grep")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns the last 20 activity items and truncates assistant text at 2k", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tail-"))
    try {
      const longText = "a".repeat(AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX + 50)
      const toolLines = Array.from({ length: 25 }, (_, index) => {
        const timestamp = TS_USER + 1 + index
        const id = `call_${index + 1}`
        return [
          toolCallLine(timestamp, "ses_fixture", id, `tool-${index + 1}`),
          toolUpdateLine(
            timestamp,
            "ses_fixture",
            id,
            "completed",
            SECRET_PAYLOAD,
          ),
        ].join("\n")
      })
      writeSessionFixture(dir, "%2Fwork", "ses_fixture", {
        summary: { current_model_id: "grok-4.6" },
        updatesJsonl: [
          userLine(TS_USER, "ses_fixture", "implement"),
          ...toolLines,
          assistantLine(TS_USER + 26, "ses_fixture", "part-one-"),
          assistantLine(TS_USER + 27, "ses_fixture", longText),
        ].join("\n"),
      })

      const tail = await getTail(dir, "ses_fixture")
      expect(tail.availability).toBe("available")
      expect(tail.items).toHaveLength(AGENT_TURN_TAIL_ITEM_LIMIT)
      expect(tail.items[0]).toEqual({
        kind: "tool",
        name: "tool-7",
        status: "completed",
        at: AT_TOOL_7,
      })
      const last = tail.items[19]
      expect(last?.kind).toBe("assistant_text")
      if (last?.kind === "assistant_text") {
        expect(last.text).toBe(
          `part-one-${"a".repeat(AGENT_TURN_TAIL_ASSISTANT_TEXT_MAX - "part-one-".length)}`,
        )
        expect(last.truncated).toBe(true)
      }
      expect(JSON.stringify(tail)).not.toContain("SECRET_PAYLOAD")
      expect(
        tail.items.some(
          (item) => item.kind === "tool" && item.name === "tool-6",
        ),
      ).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns MISSING when the Session directory is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tail-"))
    try {
      mkdirSync(join(dir, "sessions"), { recursive: true })
      const tail = await getTail(dir, "ses_gone")
      expect(tail).toEqual({
        availability: "missing",
        backend: GROK_BACKEND,
        items: [],
        jumpHint: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns UNAVAILABLE when the Session store is unreadable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tail-"))
    try {
      writeFileSync(join(dir, "sessions"), "not-a-directory")
      const tail = await getTail(dir, "ses_any")
      expect(tail).toEqual({
        availability: "unavailable",
        backend: GROK_BACKEND,
        items: [],
        jumpHint: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("Session token usage still loads without fetching the tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-tail-"))
    try {
      writeSessionFixture(dir, "%2Fwork", "ses_fixture", {
        summary: {
          current_model_id: "grok-4.6",
          created_at: "2026-08-17T20:00:00.000Z",
          updated_at: "2026-08-17T20:53:26.000Z",
        },
        updatesJsonl: [
          userLine(TS_USER, "ses_fixture", "implement"),
          assistantLine(TS_TEXT, "ses_fixture", "done"),
          turnCompletedLine({
            inputTokens: 11,
            outputTokens: 3,
            reasoningTokens: 1,
            cachedReadTokens: 2,
            costUsdTicks: 100_000_000,
          }),
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

      expect(session.availability).toBe("available")
      expect(session.tokens).toEqual({
        input: 11,
        output: 3,
        reasoning: 1,
        cacheRead: 2,
        cacheWrite: 0,
      })
      expect(session.cost).toBe(costUsdFromTicks(100_000_000))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
