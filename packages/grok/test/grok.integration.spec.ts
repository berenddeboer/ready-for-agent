import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import { Grok } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const TestLayer = Grok.layerForTests().pipe(Layer.provide(BunServices.layer))

const runIntegration = process.env.GROK_INTEGRATION === "1"

describe.skipIf(!runIntegration)("Grok AgentBackend integration", () => {
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

    expect(result.backend.id).toBe("grok")
    expect(result.backend.label).toBe("Grok Build")
    expect(result.models.length).toBeGreaterThan(0)
    expect(
      result.models.every((model) => Array.isArray(model.thinkingLevels)),
    ).toBe(true)
  }, 35_000)

  it("starts and resumes a Session, switches model/effort, and invokes /review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ready-for-agent-grok-"))
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* AgentBackend
          const models = yield* backend.inspect({
            cwd,
            timeout: "30 seconds",
          })
          const model = models.models[0]
          if (model === undefined) {
            return yield* Effect.die("no grok models")
          }
          const effort = model.thinkingLevels[0] ?? null
          const altEffort =
            model.thinkingLevels.find((level) => level !== effort) ?? effort

          const started = yield* backend.startTurn({
            cwd,
            prompt: "Reply exactly START_OK. Do not use tools.",
            model: model.id,
            thinkingLevel: effort,
            timeout: "3 minutes",
          })
          const continued = yield* backend.continueTurn({
            cwd,
            sessionId: started.sessionId,
            prompt: "Reply exactly CONTINUE_OK. Do not use tools.",
            model: model.id,
            thinkingLevel: altEffort,
            timeout: "3 minutes",
          })
          const reviewed = yield* backend.continueTurn({
            cwd,
            sessionId: started.sessionId,
            command: "/review",
            prompt:
              "Review uncommitted worktree changes. If none, report clean with READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
            model: model.id,
            thinkingLevel: effort,
            timeout: "5 minutes",
          })

          return { started, continued, reviewed }
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(result.started.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      expect(result.continued.sessionId).toBe(result.started.sessionId)
      expect(result.reviewed.sessionId).toBe(result.started.sessionId)
      expect(result.started.assistantText.length).toBeGreaterThan(0)
      expect(result.continued.assistantText.length).toBeGreaterThan(0)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 600_000)
})
