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
})
