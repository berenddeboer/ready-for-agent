import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Opencode, OpencodeLive } from "../src/index.js"
import { describe, expect, it } from "bun:test"

const TestLayer = OpencodeLive.pipe(Layer.provide(BunServices.layer))

describe("Opencode integration", () => {
  it("lists models from OpenCode's active providers", async () => {
    const models = await Effect.runPromise(
      Effect.gen(function* () {
        const opencode = yield* Opencode
        return yield* opencode.listModels({
          cwd: process.cwd(),
          timeout: "30 seconds",
        })
      }).pipe(Effect.provide(TestLayer)),
    )

    expect(models.length).toBeGreaterThan(0)
    expect(models).toContain("opencode/deepseek-v4-flash-free")
    expect(models.every((model) => model.includes("/"))).toBe(true)
  }, 35_000)

  it("starts and continues a real Session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ready-for-agent-opencode-"))
    let sessionId: string | undefined

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const opencode = yield* Opencode
          const started = yield* opencode.start({
            cwd,
            prompt: "Reply exactly START_OK. Do not use tools.",
            model: "opencode/deepseek-v4-flash-free",
            variant: "low",
            timeout: "2 minutes",
          })
          yield* Effect.sync(() => {
            sessionId = started.sessionId
          })
          const continued = yield* opencode.continue({
            cwd,
            sessionId: started.sessionId,
            prompt: "Reply exactly CONTINUE_OK. Do not use tools.",
            model: "opencode/deepseek-v4-flash-free",
            variant: "low",
            timeout: "2 minutes",
          })

          return { started, continued }
        }).pipe(Effect.provide(TestLayer)),
      )

      expect(result.started.sessionId).toStartWith("ses_")
      expect(result.continued.sessionId).toBe(result.started.sessionId)
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
