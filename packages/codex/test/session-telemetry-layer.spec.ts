import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { SessionTelemetryProvider } from "@ready-for-agent/agent-backend"
import { CodexSessionTelemetryLive } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const writeRollout = (input: {
  readonly codexHome: string
  readonly sessionId: string
  readonly lines: ReadonlyArray<unknown>
}): void => {
  const sessionDirectory = join(input.codexHome, "sessions", "2026", "08", "08")
  mkdirSync(sessionDirectory, { recursive: true })
  writeFileSync(
    join(
      sessionDirectory,
      `rollout-2026-08-08T01-02-03-${input.sessionId}.jsonl`,
    ),
    `${input.lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  )
}

const getTelemetry = (input: {
  readonly codexHome: string
  readonly sessionId: string
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* SessionTelemetryProvider
      return yield* provider.getSession(input.sessionId)
    }).pipe(
      Effect.provide(CodexSessionTelemetryLive({ codexHome: input.codexHome })),
    ),
  )

const getTail = (input: {
  readonly codexHome: string
  readonly sessionId: string
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* SessionTelemetryProvider
      return yield* provider.getTail(input.sessionId)
    }).pipe(
      Effect.provide(CodexSessionTelemetryLive({ codexHome: input.codexHome })),
    ),
  )

describe("CodexSessionTelemetryLive", () => {
  it("live-reads the last cumulative rollout totals with Codex Build provenance", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-telemetry-"))
    try {
      const sessionId = "019fab2c-9466-7432-ad16-9de23f94f2db"
      writeRollout({
        codexHome,
        sessionId,
        lines: [
          {
            timestamp: "2026-08-08T01:02:03.123Z",
            type: "session_meta",
            payload: {
              id: sessionId,
              timestamp: "2026-08-08T01:02:03.123Z",
              model_provider: "openai",
            },
          },
          {
            timestamp: "2026-08-08T01:02:04.000Z",
            type: "turn_context",
            payload: { model: "gpt-5.5-codex", effort: "high" },
          },
          {
            timestamp: "2026-08-08T01:02:05.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 100,
                  output_tokens: 20,
                  reasoning_output_tokens: 5,
                  cached_input_tokens: 60,
                  cache_write_input_tokens: 7,
                },
              },
            },
          },
          {
            timestamp: "2026-08-08T01:03:00.456Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: {
                  input_tokens: 50,
                  output_tokens: 10,
                  reasoning_output_tokens: 2,
                  cached_input_tokens: 30,
                  cache_write_input_tokens: 3,
                },
                total_token_usage: {
                  input_tokens: 250,
                  output_tokens: 45,
                  reasoning_output_tokens: 11,
                  cached_input_tokens: 140,
                  cache_write_input_tokens: 13,
                },
              },
            },
          },
        ],
      })

      await expect(getTelemetry({ codexHome, sessionId })).resolves.toEqual({
        id: sessionId,
        availability: "available",
        backend: { id: "codex", label: "Codex Build" },
        model: {
          providerId: "openai",
          id: "gpt-5.5-codex",
          thinkingLevel: "high",
        },
        tokens: {
          input: 250,
          output: 45,
          reasoning: 11,
          cacheRead: 140,
          cacheWrite: 13,
        },
        cost: null,
        createdAt: "2026-08-08T01:02:03.123Z",
        updatedAt: "2026-08-08T01:03:00.456Z",
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("maps a safe missing Session to MISSING with Codex Build provenance", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-telemetry-"))
    try {
      mkdirSync(join(codexHome, "sessions"), { recursive: true })
      await expect(
        getTelemetry({ codexHome, sessionId: "no-such-session" }),
      ).resolves.toEqual({
        id: "no-such-session",
        availability: "missing",
        backend: { id: "codex", label: "Codex Build" },
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

  it("maps unusable corrupt Session data to UNAVAILABLE with null metrics", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-telemetry-"))
    try {
      const sessionId = "corrupt-telemetry-session"
      const sessionDirectory = join(codexHome, "sessions", "2026", "08", "08")
      mkdirSync(sessionDirectory, { recursive: true })
      writeFileSync(
        join(
          sessionDirectory,
          `rollout-2026-08-08T01-02-03-${sessionId}.jsonl`,
        ),
        "not-json\n",
      )

      await expect(getTelemetry({ codexHome, sessionId })).resolves.toEqual({
        id: sessionId,
        availability: "unavailable",
        backend: { id: "codex", label: "Codex Build" },
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

  it("serves the latest Agent Turn Tail without fetching it from session()", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-telemetry-"))
    try {
      const sessionId = "019fab2c-9466-7432-ad16-9de23f94f2db"
      writeRollout({
        codexHome,
        sessionId,
        lines: [
          {
            timestamp: "2026-08-08T01:02:03.123Z",
            type: "session_meta",
            payload: { id: sessionId },
          },
          {
            timestamp: "2026-08-08T01:02:04.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "review the tests" },
          },
          {
            timestamp: "2026-08-08T01:02:05.000Z",
            type: "response_item",
            payload: {
              type: "custom_tool_call",
              name: "bun test",
              status: "failed",
              call_id: "call_tail",
              input: "PAYLOAD_MUST_STAY_OUT",
            },
          },
          {
            timestamp: "2026-08-08T01:02:06.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "tests failed" },
          },
          {
            timestamp: "2026-08-08T01:03:00.456Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 250,
                  output_tokens: 45,
                  reasoning_output_tokens: 11,
                  cached_input_tokens: 140,
                  cache_write_input_tokens: 13,
                },
              },
            },
          },
        ],
      })

      const session = await getTelemetry({ codexHome, sessionId })
      expect(session.availability).toBe("available")
      expect(session.tokens).toEqual({
        input: 250,
        output: 45,
        reasoning: 11,
        cacheRead: 140,
        cacheWrite: 13,
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
            at: "2026-08-08T01:02:05.000Z",
          },
          {
            kind: "assistant_text",
            text: "tests failed",
            truncated: false,
            at: "2026-08-08T01:02:06.000Z",
          },
        ],
      })
      expect(JSON.stringify(session)).not.toContain("PAYLOAD_MUST_STAY_OUT")
      expect(JSON.stringify(tail)).not.toContain("PAYLOAD_MUST_STAY_OUT")
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it("maps a missing Session to MISSING tail without failing", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-telemetry-"))
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

  it("maps unsafe Session ID path segments to non-AVAILABLE telemetry", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-telemetry-"))
    try {
      mkdirSync(join(codexHome, "sessions"), { recursive: true })
      await expect(
        getTelemetry({ codexHome, sessionId: "../escape" }),
      ).resolves.toMatchObject({
        id: "../escape",
        availability: "missing",
        backend: { id: "codex", label: "Codex Build" },
        tokens: null,
      })
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })
})
