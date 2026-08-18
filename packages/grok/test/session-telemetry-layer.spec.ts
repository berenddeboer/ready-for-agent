import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { SessionTelemetryProvider } from "@ready-for-agent/agent-backend"
import {
  GROK_SESSION_PROVIDER_ID,
  GrokSessionTelemetryLive,
  costUsdFromTicks,
} from "../src/index.js"
import { describe, expect, test } from "bun:test"

describe("GrokSessionTelemetryLive", () => {
  test("maps store session to SessionTelemetry with Grok Build backend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-telemetry-"))
    try {
      const sessionDir = join(dir, "sessions", "%2Fproj", "ses_map")
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, "summary.json"),
        JSON.stringify({
          current_model_id: "grok-4.5",
          reasoning_effort: "high",
          created_at: "2026-07-25T01:00:00.000Z",
          updated_at: "2026-07-25T02:00:00.000Z",
        }),
      )
      writeFileSync(
        join(sessionDir, "updates.jsonl"),
        `${JSON.stringify({
          params: {
            update: {
              sessionUpdate: "turn_completed",
              usage: {
                inputTokens: 10,
                outputTokens: 4,
                reasoningTokens: 1,
                cachedReadTokens: 2,
                costUsdTicks: 100_000_000,
              },
            },
          },
        })}\n`,
      )

      const runtime = ManagedRuntime.make(
        GrokSessionTelemetryLive({ grokHome: dir }),
      )
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const provider = yield* SessionTelemetryProvider
          return yield* provider.getSession("ses_map")
        }),
      )
      await runtime.dispose()

      expect(session.availability).toBe("available")
      expect(session.backend).toEqual({ id: "grok", label: "Grok Build" })
      expect(session.model).toEqual({
        providerId: GROK_SESSION_PROVIDER_ID,
        id: "grok-4.5",
        thinkingLevel: "high",
      })
      expect(session.tokens).toEqual({
        input: 10,
        output: 4,
        reasoning: 1,
        cacheRead: 2,
        cacheWrite: 0,
      })
      expect(session.cost).toBe(costUsdFromTicks(100_000_000))
      expect(session.createdAt).toBe("2026-07-25T01:00:00.000Z")
      expect(session.updatedAt).toBe("2026-07-25T02:00:00.000Z")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns missing rather than unsupported for unknown session ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-telemetry-"))
    try {
      mkdirSync(join(dir, "sessions"), { recursive: true })
      const runtime = ManagedRuntime.make(
        GrokSessionTelemetryLive({ grokHome: dir }),
      )
      const session = await runtime.runPromise(
        Effect.gen(function* () {
          const provider = yield* SessionTelemetryProvider
          return yield* provider.getSession("ses_unknown")
        }),
      )
      await runtime.dispose()
      expect(session.availability).toBe("missing")
      expect(session.backend.id).toBe("grok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("maps store tail without fetching usage through session()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-telemetry-"))
    try {
      const sessionDir = join(dir, "sessions", "%2Fproj", "ses_map")
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, "summary.json"),
        JSON.stringify({
          current_model_id: "grok-4.6",
          created_at: "2026-08-17T20:00:00.000Z",
          updated_at: "2026-08-17T20:53:26.000Z",
        }),
      )
      writeFileSync(
        join(sessionDir, "updates.jsonl"),
        [
          JSON.stringify({
            timestamp: 1787000004,
            method: "session/update",
            params: {
              sessionId: "ses_map",
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: "implement" },
              },
            },
          }),
          JSON.stringify({
            timestamp: 1787000005,
            method: "session/update",
            params: {
              sessionId: "ses_map",
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "call_1",
                title: "run_terminal_command",
                rawInput: { command: "bun test" },
                _meta: {
                  "x.ai/tool": { name: "run_terminal_command" },
                },
              },
            },
          }),
          JSON.stringify({
            timestamp: 1787000005,
            method: "session/update",
            params: {
              sessionId: "ses_map",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "call_1",
                status: "failed",
                rawOutput: { output: "SECRET_PAYLOAD" },
              },
            },
          }),
          JSON.stringify({
            timestamp: 1787000006,
            method: "session/update",
            params: {
              sessionId: "ses_map",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "tests failed" },
              },
            },
          }),
          JSON.stringify({
            params: {
              update: {
                sessionUpdate: "turn_completed",
                usage: {
                  inputTokens: 10,
                  outputTokens: 4,
                  reasoningTokens: 1,
                  cachedReadTokens: 2,
                  costUsdTicks: 100_000_000,
                },
              },
            },
          }),
        ].join("\n"),
      )

      const runtime = ManagedRuntime.make(
        GrokSessionTelemetryLive({ grokHome: dir }),
      )
      const { session, tail } = await runtime.runPromise(
        Effect.gen(function* () {
          const provider = yield* SessionTelemetryProvider
          const usage = yield* provider.getSession("ses_map")
          const peek = yield* provider.getTail("ses_map")
          return { session: usage, tail: peek }
        }),
      )
      await runtime.dispose()

      expect(session.availability).toBe("available")
      expect(session.tokens).toEqual({
        input: 10,
        output: 4,
        reasoning: 1,
        cacheRead: 2,
        cacheWrite: 0,
      })
      expect(tail).toEqual({
        availability: "available",
        backend: { id: "grok", label: "Grok Build" },
        jumpHint: false,
        items: [
          {
            kind: "tool",
            name: "run_terminal_command",
            status: "failed",
            at: "2026-08-17T20:53:25.000Z",
          },
          {
            kind: "assistant_text",
            text: "tests failed",
            truncated: false,
            at: "2026-08-17T20:53:26.000Z",
          },
        ],
      })
      expect(JSON.stringify(tail)).not.toContain("SECRET_PAYLOAD")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
