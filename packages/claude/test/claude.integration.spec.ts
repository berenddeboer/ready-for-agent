import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { AgentBackend } from "@ready-for-agent/agent-backend"
import { Claude } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const TestLayer = Claude.layerForTests().pipe(Layer.provide(BunServices.layer))

/**
 * Opt-in only: never set in CI. Requires a real `claude` binary and ambient
 * auth (`claude auth login` or `ANTHROPIC_API_KEY`).
 *
 * Run with: `CLAUDE_INTEGRATION=1 bun --conditions=@ready-for-agent/source test`
 */
const runIntegration = process.env.CLAUDE_INTEGRATION === "1"

describe.skipIf(!runIntegration)("Claude AgentBackend integration", () => {
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

    expect(result.backend.id).toBe("claude")
    expect(result.backend.label).toBe("Claude Code")
    expect(result.models.length).toBeGreaterThan(0)
    expect(
      result.models.every((model) => Array.isArray(model.thinkingLevels)),
    ).toBe(true)
    expect(
      result.models.every((model) => model.thinkingLevels.length > 0),
    ).toBe(true)
  }, 35_000)

  it("starts and resumes a Session, switches model/effort, and invokes /review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ready-for-agent-claude-"))
    try {
      // Real Agent Turns always run in worktrees; mirror that for live
      // integration so Claude Code sees a normal project layout.
      const init = Bun.spawn(["git", "init"], {
        cwd,
        stdout: "ignore",
        stderr: "pipe",
      })
      const initExit = await init.exited
      if (initExit !== 0) {
        const stderr = (await new Response(init.stderr).text()).trim()
        throw new Error(
          `git init failed for claude integration cwd (exit ${initExit})${stderr.length > 0 ? `: ${stderr.slice(0, 240)}` : ""}`,
        )
      }

      // Live suite asserts onSessionId delivered the durable preassigned
      // Session UUID (same ID as the completed turn). Still-running timing is
      // covered by the unit suite's fiber race, not re-proven here.
      let observedSessionId: string | undefined

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const backend = yield* AgentBackend
          const models = yield* backend.inspect({
            cwd,
            timeout: "30 seconds",
          })
          const model = models.models[0]
          if (model === undefined) {
            return yield* Effect.die("no claude models")
          }
          const altModel = models.models.find((entry) => entry.id !== model.id)
          if (altModel === undefined) {
            return yield* Effect.die(
              "catalog must expose at least two models to exercise mid-Session model switch",
            )
          }
          const effort = model.thinkingLevels[0]
          if (effort === undefined) {
            return yield* Effect.die(`model ${model.id} has no Thinking Levels`)
          }
          const altEffort = altModel.thinkingLevels.find(
            (level) => level !== effort,
          )
          if (altEffort === undefined) {
            return yield* Effect.die(
              `no Thinking Level on ${altModel.id} distinct from ${effort} for mid-Session switch`,
            )
          }

          const started = yield* backend.startTurn({
            cwd,
            prompt: "Reply exactly START_OK. Do not use tools.",
            model: model.id,
            thinkingLevel: effort,
            timeout: "3 minutes",
            onSessionId: (sessionId) =>
              Effect.sync(() => {
                observedSessionId = sessionId
              }),
          })
          const continued = yield* backend.continueTurn({
            cwd,
            sessionId: started.sessionId,
            prompt: "Reply exactly CONTINUE_OK. Do not use tools.",
            model: altModel.id,
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

      expect(observedSessionId).toBeDefined()
      expect(observedSessionId).toBe(result.started.sessionId)
      expect(result.started.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      expect(result.continued.sessionId).toBe(result.started.sessionId)
      expect(result.reviewed.sessionId).toBe(result.started.sessionId)
      expect(result.started.assistantText.length).toBeGreaterThan(0)
      expect(result.continued.assistantText.length).toBeGreaterThan(0)
      expect(result.reviewed.assistantText.length).toBeGreaterThan(0)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 600_000)
})
