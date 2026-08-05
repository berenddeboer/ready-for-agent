import { Effect } from "effect"
import { SessionTelemetryProvider } from "@ready-for-agent/agent-backend"
import { ClaudeSessionTelemetryLive } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("ClaudeSessionTelemetryLive", () => {
  it("reports Session Telemetry unsupported for any session id", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* SessionTelemetryProvider
        return yield* provider.getSession("any-session-id")
      }).pipe(Effect.provide(ClaudeSessionTelemetryLive())),
    )

    expect(result).toEqual({
      id: "any-session-id",
      availability: "unsupported",
      backend: { id: "claude", label: "Claude Code" },
      model: null,
      tokens: null,
      cost: null,
      createdAt: null,
      updatedAt: null,
    })
  })
})
