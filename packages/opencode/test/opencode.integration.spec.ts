import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import { Opencode } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const TestLayer = Opencode.layerForTests(
  process.env.KEYMAXXER_SIDECAR_URL ??
    "http://127.0.0.1:6057/integration-test/mcp",
).pipe(Layer.provide(BunServices.layer))

const runIntegration = process.env.OPENCODE_INTEGRATION === "1"

describe.skipIf(!runIntegration)("Opencode AgentBackend integration", () => {
  it("inspects models through the generic Agent Backend contract", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const backend = yield* AgentBackend
        return yield* backend.inspect({
          cwd: process.cwd(),
          timeout: "30 seconds",
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(result.backend.id).toBe("opencode")
    expect(result.models.length).toBeGreaterThan(0)
    expect(
      result.models.some(
        (model) => model.id === "opencode/deepseek-v4-flash-free",
      ),
    ).toBe(true)
    expect(result.models.every((model) => model.id.includes("/"))).toBe(true)
    expect(
      result.models.every((model) => Array.isArray(model.thinkingLevels)),
    ).toBe(true)
  }, 35_000)

  it("starts and continues a real Session through the generic contract", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ready-for-agent-opencode-"))
    let sessionId: string | undefined

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* AgentBackend
          const started = yield* backend.startTurn({
            cwd,
            prompt: "Reply exactly START_OK. Do not use tools.",
            model: "opencode/deepseek-v4-flash-free",
            thinkingLevel: "low",
            timeout: "2 minutes",
          })
          yield* Effect.sync(() => {
            sessionId = started.sessionId
          })
          const continued = yield* backend.continueTurn({
            cwd,
            sessionId: started.sessionId,
            prompt: "Reply exactly CONTINUE_OK. Do not use tools.",
            model: "opencode/deepseek-v4-flash-free",
            thinkingLevel: "low",
            timeout: "2 minutes",
          })

          return { started, continued }
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(result.started.sessionId).toStartWith("ses_")
      expect(result.continued.sessionId).toBe(result.started.sessionId)
      expect(result.started.assistantText.length).toBeGreaterThan(0)
    } finally {
      if (sessionId !== undefined) {
        const deletion = Bun.spawn(
          ["opencode", "session", "delete", sessionId],
          { cwd, stdout: "ignore", stderr: "ignore" },
        )
        await deletion.exited
      }
      await rm(cwd, { recursive: true, force: true })
    }
  }, 180_000)
})
