import { Effect, Fiber } from "effect"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  ActiveAgentBackendLive,
  AgentBackend,
  AgentBackendConfigError,
  type AgentBackendId,
  type ResolveAgentBackendRuntime,
  SessionTelemetryProvider,
  getBuiltInAgentBackend,
  unsupportedSessionTelemetry,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const registration = (id: AgentBackendId) => {
  const found = getBuiltInAgentBackend(id)
  if (found === undefined) {
    throw new Error(`missing registration ${id}`)
  }
  return found
}

const makeResolve =
  (options: {
    readonly failInspectFor?: ReadonlySet<string>
    readonly modelsByBackend?: Record<
      string,
      ReadonlyArray<{ id: string; thinkingLevels: readonly string[] }>
    >
  }): ResolveAgentBackendRuntime =>
  (backendId) => {
    const reg = registration(backendId)
    const models = options.modelsByBackend?.[backendId] ?? [
      { id: `${backendId}/model-a`, thinkingLevels: ["low", "high"] },
    ]
    return Effect.succeed({
      registration: reg,
      adapter: {
        inspect: () => {
          if (options.failInspectFor?.has(backendId)) {
            return Effect.fail(
              new AgentBackendConfigError({
                message: `${backendId} binary missing`,
              }),
            )
          }
          return Effect.succeed({
            backend: reg.descriptor,
            models: [...models],
          })
        },
        startTurn: () => Effect.die("unused"),
        continueTurn: () => Effect.die("unused"),
      },
      telemetry: {
        getSession: (sessionId: string) =>
          Effect.succeed(
            unsupportedSessionTelemetry(sessionId, reg.descriptor),
          ),
      },
    })
  }

describe("ActiveAgentBackend hot-activate", () => {
  it("activates a new backend without restart limbo and matches Selected to Active", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({}),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const agent = yield* AgentBackend
        yield* active.recheck({ cwd: "/tmp" })
        let status = yield* active.getStatus
        expect(status.kind).toBe("ready")
        expect(status.activeBackend.id).toBe("opencode")
        expect(status.selectedBackend.id).toBe("opencode")
        expect(status.models[0]?.id).toBe("opencode/model-a")

        status = yield* active.activate(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(status.kind).toBe("ready")
        expect(status.activeBackend.id).toBe("grok")
        expect(status.selectedBackend.id).toBe("grok")
        expect(status.models[0]?.id).toBe("grok/model-a")

        // Proxy AgentBackend uses the new adapter after activate.
        const inspected = yield* agent.inspect({ cwd: "/tmp" })
        expect(inspected.backend.id).toBe("grok")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("leaves Unavailable on the new backend when hot-activate inspect fails", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({
        failInspectFor: new Set([AGENT_BACKEND_IDS.grok]),
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck({ cwd: "/tmp" })
        const status = yield* active.activate(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(status.kind).toBe("unavailable")
        expect(status.activeBackend.id).toBe("grok")
        expect(status.selectedBackend.id).toBe("grok")
        expect(status.reason).toContain("grok binary missing")
        expect(status.models).toEqual([])
      }).pipe(Effect.provide(layer)),
    )
  })

  it("previews another backend without changing Active", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({
        modelsByBackend: {
          opencode: [{ id: "opencode/live", thinkingLevels: [] }],
          grok: [{ id: "grok/preview", thinkingLevels: ["high"] }],
        },
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck({ cwd: "/tmp" })
        const preview = yield* active.preview(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(preview.kind).toBe("ready")
        expect(preview.backend.id).toBe("grok")
        expect(preview.models[0]?.id).toBe("grok/preview")

        const status = yield* active.getStatus
        expect(status.activeBackend.id).toBe("opencode")
        expect(status.models[0]?.id).toBe("opencode/live")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("discards recheck results after Active is swapped mid-inspect", async () => {
    let releaseInspect: (() => void) | undefined
    const inspectGate = new Promise<void>((resolve) => {
      releaseInspect = resolve
    })
    const resolveRuntime: ResolveAgentBackendRuntime = (backendId) => {
      const reg = registration(backendId)
      return Effect.succeed({
        registration: reg,
        adapter: {
          inspect: () =>
            Effect.gen(function* () {
              if (backendId === AGENT_BACKEND_IDS.opencode) {
                yield* Effect.promise(() => inspectGate)
              }
              return {
                backend: reg.descriptor,
                models: [
                  {
                    id: `${backendId}/model-a`,
                    thinkingLevels: ["low"] as const,
                  },
                ],
              }
            }),
          startTurn: () => Effect.die("unused"),
          continueTurn: () => Effect.die("unused"),
        },
        telemetry: {
          getSession: (sessionId: string) =>
            Effect.succeed(
              unsupportedSessionTelemetry(sessionId, reg.descriptor),
            ),
        },
      })
    }

    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const recheckFiber = yield* Effect.forkChild(
          active.recheck({ cwd: "/tmp" }),
        )
        // Let recheck capture OpenCode adapter and block in inspect.
        yield* Effect.yieldNow
        yield* active.activate(AGENT_BACKEND_IDS.grok, { cwd: "/tmp" })
        releaseInspect?.()
        yield* Fiber.join(recheckFiber)
        const status = yield* active.getStatus
        expect(status.activeBackend.id).toBe("grok")
        expect(status.models[0]?.id).toBe("grok/model-a")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("preview failure keeps Active unchanged", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({
        failInspectFor: new Set([AGENT_BACKEND_IDS.grok]),
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck({ cwd: "/tmp" })
        const preview = yield* active.preview(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(preview.kind).toBe("unavailable")
        expect(preview.reason).toContain("grok binary missing")

        const status = yield* active.getStatus
        expect(status.kind).toBe("ready")
        expect(status.activeBackend.id).toBe("opencode")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("does not export restart_required status kinds", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({}),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const status = yield* active.getStatus
        expect(status.kind === "ready" || status.kind === "unavailable").toBe(
          true,
        )
        // SessionTelemetryProvider is provided from the same layer.
        const telemetry = yield* SessionTelemetryProvider
        const session = yield* telemetry.getSession("ses_x")
        expect(session.availability).toBe("unsupported")
      }).pipe(Effect.provide(layer)),
    )
  })
})
