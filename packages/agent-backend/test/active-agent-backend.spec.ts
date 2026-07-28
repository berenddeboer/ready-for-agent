import { Effect, Fiber } from "effect"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  ActiveAgentBackendLive,
  AgentBackend,
  AgentBackendConfigError,
  type AgentBackendId,
  type AgentTurnResult,
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

const turnResult = (sessionId: string): AgentTurnResult => ({
  sessionId,
  assistantText: "ok",
})

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
        startTurn: () => Effect.succeed(turnResult(`${backendId}-start`)),
        continueTurn: () => Effect.succeed(turnResult(`${backendId}-continue`)),
      },
      telemetry: {
        getSession: (sessionId: string) =>
          Effect.succeed({
            id: sessionId,
            availability: "available" as const,
            backend: reg.descriptor,
            model: {
              providerId: backendId,
              id: `${backendId}/model-a`,
              thinkingLevel: null,
            },
            tokens: null,
            cost: null,
            createdAt: null,
            updatedAt: null,
          }),
      },
    })
  }

describe("ActiveAgentBackend multi-backend registry", () => {
  it("keeps two backends Active concurrently", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({}),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, { cwd: "/tmp" })
        yield* active.activate(AGENT_BACKEND_IDS.grok, { cwd: "/tmp" })

        const statuses = yield* active.listStatuses
        const ids = statuses.map((s) => s.backend.id).sort()
        expect(ids).toEqual(["grok", "opencode"])
        expect(statuses.every((s) => s.kind === "ready")).toBe(true)

        const opencode = yield* active.getBackendStatus(
          AGENT_BACKEND_IDS.opencode,
        )
        const grok = yield* active.getBackendStatus(AGENT_BACKEND_IDS.grok)
        expect(opencode?.models[0]?.id).toBe("opencode/model-a")
        expect(grok?.models[0]?.id).toBe("grok/model-a")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("uses selectedBackendId as process-wide proxy when multi-seeding", async () => {
    // List order puts opencode first, but Config selected is grok.
    const layer = ActiveAgentBackendLive({
      initialBackendIds: [AGENT_BACKEND_IDS.opencode, AGENT_BACKEND_IDS.grok],
      selectedBackendId: AGENT_BACKEND_IDS.grok,
      resolveRuntime: makeResolve({}),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const status = yield* active.getStatus
        expect(status.activeBackend.id).toBe("grok")
        expect(status.selectedBackend.id).toBe("grok")
        const ids = (yield* active.listStatuses).map((s) => s.backend.id).sort()
        expect(ids).toEqual(["grok", "opencode"])
      }).pipe(Effect.provide(layer)),
    )
  })

  it("activates on demand and drops when unused", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({}),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, { cwd: "/tmp" })

        const activated = yield* active.activate(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(activated.kind).toBe("ready")
        expect(activated.backend.id).toBe("grok")
        expect(yield* active.getBackendStatus(AGENT_BACKEND_IDS.grok)).not.toBe(
          null,
        )

        // Same-backend activate skips re-inspect and leaves entry Ready.
        const again = yield* active.activate(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(again.kind).toBe("ready")
        expect(again.models[0]?.id).toBe("grok/model-a")

        yield* active.drop(AGENT_BACKEND_IDS.grok)
        expect(yield* active.getBackendStatus(AGENT_BACKEND_IDS.grok)).toBe(
          null,
        )
        expect((yield* active.listStatuses).map((s) => s.backend.id)).toEqual([
          "opencode",
        ])

        // setSelectedOrInUse drops backends outside the set and activates missing.
        yield* active.setSelectedOrInUse([AGENT_BACKEND_IDS.grok], {
          cwd: "/tmp",
        })
        const afterSync = yield* active.listStatuses
        expect(afterSync.map((s) => s.backend.id)).toEqual(["grok"])
        expect(afterSync[0]?.kind).toBe("ready")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("marks per-backend Unavailable and rechecks one id", async () => {
    const layer = ActiveAgentBackendLive({
      initialBackendIds: [AGENT_BACKEND_IDS.opencode, AGENT_BACKEND_IDS.grok],
      resolveRuntime: makeResolve({
        failInspectFor: new Set([AGENT_BACKEND_IDS.grok]),
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const openStatus = yield* active.recheck(AGENT_BACKEND_IDS.opencode, {
          cwd: "/tmp",
        })
        expect(openStatus.kind).toBe("ready")

        const grokStatus = yield* active.recheck(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(grokStatus.kind).toBe("unavailable")
        expect(grokStatus.reason).toContain("grok binary missing")
        expect(grokStatus.models).toEqual([])

        // OpenCode stays Ready while Grok is Unavailable.
        const openAfter = yield* active.getBackendStatus(
          AGENT_BACKEND_IDS.opencode,
        )
        expect(openAfter?.kind).toBe("ready")

        yield* active.requireAgentTurnsAllowed(AGENT_BACKEND_IDS.opencode)
        const blocked = yield* Effect.result(
          active.requireAgentTurnsAllowed(AGENT_BACKEND_IDS.grok),
        )
        expect(blocked._tag).toBe("Failure")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("dispatches start/continue/telemetry by backend id", async () => {
    const layer = ActiveAgentBackendLive({
      initialBackendIds: [AGENT_BACKEND_IDS.opencode, AGENT_BACKEND_IDS.grok],
      resolveRuntime: makeResolve({}),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, { cwd: "/tmp" })
        yield* active.recheck(AGENT_BACKEND_IDS.grok, { cwd: "/tmp" })

        const openStart = yield* active.startTurn(AGENT_BACKEND_IDS.opencode, {
          prompt: "hi",
          cwd: "/tmp",
          model: "opencode/model-a",
          thinkingLevel: null,
        })
        expect(openStart.sessionId).toBe("opencode-start")

        const grokContinue = yield* active.continueTurn(
          AGENT_BACKEND_IDS.grok,
          {
            sessionId: "ses_g",
            prompt: "more",
            cwd: "/tmp",
            model: "grok/model-a",
            thinkingLevel: null,
          },
        )
        expect(grokContinue.sessionId).toBe("grok-continue")

        const openTelemetry = yield* active.getSessionTelemetry({
          backendId: AGENT_BACKEND_IDS.opencode,
          sessionId: "ses_o",
        })
        expect(openTelemetry.backend.id).toBe("opencode")
        expect(openTelemetry.availability).toBe("available")
        expect(openTelemetry.model?.providerId).toBe("opencode")

        // Grok Build supports SessionTelemetry; dispatch scopes the response
        // to the requested backend id (file-backed live read in production).
        const grokTelemetry = yield* active.getSessionTelemetry({
          backendId: AGENT_BACKEND_IDS.grok,
          sessionId: "ses_g",
        })
        expect(grokTelemetry.backend.id).toBe("grok")
        expect(grokTelemetry.availability).toBe("available")
        expect(grokTelemetry.model?.providerId).toBe("grok")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("preview does not flip the Active set", async () => {
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
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, { cwd: "/tmp" })
        const preview = yield* active.preview(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(preview.kind).toBe("ready")
        expect(preview.backend.id).toBe("grok")
        expect(preview.models[0]?.id).toBe("grok/preview")

        expect(yield* active.getBackendStatus(AGENT_BACKEND_IDS.grok)).toBe(
          null,
        )
        const statuses = yield* active.listStatuses
        expect(statuses.map((s) => s.backend.id)).toEqual(["opencode"])
        expect(statuses[0]?.models[0]?.id).toBe("opencode/live")
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
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, { cwd: "/tmp" })
        const status = yield* active.activate(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(status.kind).toBe("unavailable")
        expect(status.backend.id).toBe("grok")
        expect(status.reason).toContain("grok binary missing")
        expect(status.models).toEqual([])

        // Original backend remains Active and Ready.
        const open = yield* active.getBackendStatus(AGENT_BACKEND_IDS.opencode)
        expect(open?.kind).toBe("ready")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("discards recheck results after the backend is dropped mid-inspect", async () => {
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
          active.recheck(AGENT_BACKEND_IDS.opencode, { cwd: "/tmp" }),
        )
        // Let recheck capture OpenCode adapter and block in inspect.
        yield* Effect.yieldNow
        yield* active.setSelectedOrInUse([AGENT_BACKEND_IDS.grok], {
          cwd: "/tmp",
        })
        releaseInspect?.()
        yield* Fiber.join(recheckFiber)
        const statuses = yield* active.listStatuses
        expect(statuses.map((s) => s.backend.id)).toEqual(["grok"])
        expect(statuses[0]?.models[0]?.id).toBe("grok/model-a")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("preview failure keeps Active set unchanged", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({
        failInspectFor: new Set([AGENT_BACKEND_IDS.grok]),
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, { cwd: "/tmp" })
        const preview = yield* active.preview(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(preview.kind).toBe("unavailable")
        expect(preview.reason).toContain("grok binary missing")

        expect(yield* active.getBackendStatus(AGENT_BACKEND_IDS.grok)).toBe(
          null,
        )
        const status = yield* active.getStatus
        expect(status.kind).toBe("ready")
        expect(status.activeBackend.id).toBe("opencode")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("process-wide AgentBackend proxy follows activate", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({}),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const agent = yield* AgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, { cwd: "/tmp" })
        let inspected = yield* agent.inspect({ cwd: "/tmp" })
        expect(inspected.backend.id).toBe("opencode")
        expect((yield* active.getActiveRegistration).descriptor.id).toBe(
          "opencode",
        )

        // activate moves the transitional process-wide proxy (until #466).
        yield* active.activate(AGENT_BACKEND_IDS.grok, { cwd: "/tmp" })
        inspected = yield* agent.inspect({ cwd: "/tmp" })
        expect(inspected.backend.id).toBe("grok")
        expect((yield* active.getActiveRegistration).descriptor.id).toBe("grok")

        const turn = yield* agent.startTurn({
          prompt: "hi",
          cwd: "/tmp",
          model: "grok/model-a",
          thinkingLevel: null,
        })
        expect(turn.sessionId).toBe("grok-start")

        // Both backends remain Active; only the proxy target moved.
        const ids = (yield* active.listStatuses).map((s) => s.backend.id).sort()
        expect(ids).toEqual(["grok", "opencode"])

        const telemetry = yield* SessionTelemetryProvider
        const session = yield* telemetry.getSession("ses_x")
        expect(session.backend.id).toBe("grok")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("recheck does not expand the Active set for missing backends", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({}),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, { cwd: "/tmp" })
        const missing = yield* active.recheck(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(missing.kind).toBe("unavailable")
        expect(missing.reason).toContain("not Active")
        expect(yield* active.getBackendStatus(AGENT_BACKEND_IDS.grok)).toBe(
          null,
        )
        expect((yield* active.listStatuses).map((s) => s.backend.id)).toEqual([
          "opencode",
        ])
      }).pipe(Effect.provide(layer)),
    )
  })

  it("getRegistration prefers the Active entry when present", async () => {
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({}),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, { cwd: "/tmp" })
        const reg = yield* active.getRegistration(AGENT_BACKEND_IDS.opencode)
        expect(reg.descriptor.id).toBe("opencode")
        // Unknown / non-active still falls back to built-in table.
        const builtIn = yield* active.getRegistration(AGENT_BACKEND_IDS.grok)
        expect(builtIn.descriptor.id).toBe("grok")
      }).pipe(Effect.provide(layer)),
    )
  })
})
