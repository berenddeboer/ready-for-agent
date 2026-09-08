import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import {
  AGENT_BACKEND_IDS,
  AGENT_MODEL_CATALOG_FRESHNESS_MS,
  ActiveAgentBackend,
  ActiveAgentBackendLive,
  AgentBackend,
  AgentBackendConfigError,
  type AgentBackendError,
  AgentBackendExitError,
  type AgentBackendId,
  AgentBackendMalformedOutputError,
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
    readonly providerByBackend?: Record<
      string,
      { id: string; label: string } | null
    >
    readonly warningsByBackend?: Record<string, ReadonlyArray<string>>
    /** Provider attached to ConfigError when inspect fails for that backend. */
    readonly failInspectProviderByBackend?: Record<
      string,
      { id: string; label: string }
    >
  }): ResolveAgentBackendRuntime =>
  (backendId) => {
    const reg = registration(backendId)
    const models = options.modelsByBackend?.[backendId] ?? [
      { id: `${backendId}/model-a`, thinkingLevels: ["low", "high"] },
    ]
    const provider =
      options.providerByBackend !== undefined
        ? (options.providerByBackend[backendId] ?? null)
        : null
    const warnings = options.warningsByBackend?.[backendId] ?? []
    return Effect.succeed({
      registration: reg,
      adapter: {
        inspect: () => {
          if (options.failInspectFor?.has(backendId)) {
            const failProvider =
              options.failInspectProviderByBackend?.[backendId]
            return Effect.fail(
              new AgentBackendConfigError({
                message: `${backendId} binary missing`,
                ...(failProvider !== undefined
                  ? { provider: failProvider }
                  : {}),
              }),
            )
          }
          return Effect.succeed({
            backend: reg.descriptor,
            models: [...models],
            provider,
            warnings: [...warnings],
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
        getTail: () =>
          Effect.succeed({
            availability: "unsupported" as const,
            backend: reg.descriptor,
            items: [],
            jumpHint: false,
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
        expect(openStatus.provider).toBeNull()

        const grokStatus = yield* active.recheck(AGENT_BACKEND_IDS.grok, {
          cwd: "/tmp",
        })
        expect(grokStatus.kind).toBe("unavailable")
        expect(grokStatus.reason).toContain("grok binary missing")
        expect(grokStatus.models).toEqual([])
        expect(grokStatus.provider).toBeNull()

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

  it("caches inspect provider on Active status, Recheck, and Preview", async () => {
    // Issue #819: provider identity from inspect is preserved without UI rebuild.
    const bedrock = { id: "bedrock", label: "Amazon Bedrock" }
    const layer = ActiveAgentBackendLive({
      // Seed a non-Claude default so first activate inspects Claude.
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({
        providerByBackend: {
          [AGENT_BACKEND_IDS.claude]: bedrock,
          [AGENT_BACKEND_IDS.opencode]: null,
        },
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const activated = yield* active.activate(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(activated.kind).toBe("ready")
        expect(activated.provider).toEqual(bedrock)

        const cached = yield* active.getBackendStatus(AGENT_BACKEND_IDS.claude)
        expect(cached?.provider).toEqual(bedrock)

        const rechecked = yield* active.recheck(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(rechecked.provider).toEqual(bedrock)

        const singular = yield* active.getStatus
        expect(singular.provider).toEqual(bedrock)

        const preview = yield* active.preview(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(preview.kind).toBe("ready")
        expect(preview.provider).toEqual(bedrock)

        // Backends that do not report a provider stay null.
        const openPreview = yield* active.preview(AGENT_BACKEND_IDS.opencode, {
          cwd: "/tmp",
        })
        expect(openPreview.provider).toBeNull()
      }).pipe(Effect.provide(layer)),
    )
  })

  it("caches inspect warnings with catalog on Ready status, Recheck, and Preview", async () => {
    // Issue #820: non-fatal Bedrock discovery warnings travel with Ready status.
    const bedrock = { id: "bedrock", label: "Amazon Bedrock" }
    const warning =
      "Could not list Amazon Bedrock inference profiles: access denied. Fix AWS configuration (credentials, region, bedrock:ListInferenceProfiles), then Recheck Agent Backend."
    const profiles = [
      {
        id: "us.anthropic.claude-sonnet-4-6",
        thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      },
    ]
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({
        providerByBackend: {
          [AGENT_BACKEND_IDS.claude]: bedrock,
        },
        modelsByBackend: {
          [AGENT_BACKEND_IDS.claude]: profiles,
        },
        warningsByBackend: {
          [AGENT_BACKEND_IDS.claude]: [warning],
        },
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const activated = yield* active.activate(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(activated.kind).toBe("ready")
        expect(activated.warnings).toEqual([warning])
        expect(activated.models.map((model) => model.id)).toEqual([
          "us.anthropic.claude-sonnet-4-6",
        ])

        const rechecked = yield* active.recheck(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(rechecked.kind).toBe("ready")
        expect(rechecked.warnings).toEqual([warning])
        expect(rechecked.models.map((model) => model.id)).toEqual([
          "us.anthropic.claude-sonnet-4-6",
        ])

        const preview = yield* active.preview(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(preview.kind).toBe("ready")
        expect(preview.warnings).toEqual([warning])
        expect(preview.models.map((model) => model.id)).toEqual([
          "us.anthropic.claude-sonnet-4-6",
        ])
      }).pipe(Effect.provide(layer)),
    )
  })

  it("preserves last-known provider after a failed recheck", async () => {
    const bedrock = { id: "bedrock", label: "Amazon Bedrock" }
    // Mutable set so inspect can succeed first, then fail without a provider on the error.
    const failInspectFor = new Set<string>()
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({
        failInspectFor,
        providerByBackend: {
          [AGENT_BACKEND_IDS.claude]: bedrock,
        },
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const ready = yield* active.activate(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(ready.kind).toBe("ready")
        expect(ready.provider).toEqual(bedrock)

        failInspectFor.add(AGENT_BACKEND_IDS.claude)
        const failed = yield* active.recheck(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(failed.kind).toBe("unavailable")
        expect(failed.provider).toEqual(bedrock)
        expect(failed.warnings).toEqual([])
      }).pipe(Effect.provide(layer)),
    )
  })

  it("surfaces provider from ConfigError on first failed inspect and preview", async () => {
    const bedrock = { id: "bedrock", label: "Amazon Bedrock" }
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeResolve({
        failInspectFor: new Set([AGENT_BACKEND_IDS.claude]),
        failInspectProviderByBackend: {
          [AGENT_BACKEND_IDS.claude]: bedrock,
        },
      }),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const failed = yield* active.activate(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(failed.kind).toBe("unavailable")
        expect(failed.provider).toEqual(bedrock)

        const preview = yield* active.preview(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(preview.kind).toBe("unavailable")
        expect(preview.provider).toEqual(bedrock)
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

  it("surfaces an inspect exit failure's own message as the Unavailable reason", async () => {
    const resolveRuntime: ResolveAgentBackendRuntime = (backendId) => {
      const reg = registration(backendId)
      return Effect.succeed({
        registration: reg,
        adapter: {
          inspect: () =>
            Effect.fail(
              AgentBackendExitError.new({
                exitCode: 7,
                cwd: "/tmp",
                message: "internal crash in login status",
              }),
            ),
          startTurn: () => Effect.succeed(turnResult(`${backendId}-start`)),
          continueTurn: () =>
            Effect.succeed(turnResult(`${backendId}-continue`)),
        },
        telemetry: {
          getSession: (sessionId: string) =>
            Effect.succeed(
              unsupportedSessionTelemetry(sessionId, reg.descriptor),
            ),
          getTail: () =>
            Effect.succeed({
              availability: "unsupported" as const,
              backend: reg.descriptor,
              items: [],
              jumpHint: false,
            }),
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
        const status = yield* active.recheck(AGENT_BACKEND_IDS.opencode, {
          cwd: "/tmp",
        })
        expect(status.kind).toBe("unavailable")
        expect(status.reason).toBe("internal crash in login status")
        expect(status.reason).not.toBe(
          "Agent Backend inspection failed (AgentBackendExitError)",
        )
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

  it("discards stale concurrent recheck catalog/provider/warning updates (issue #822)", async () => {
    // A slower earlier Recheck must not overwrite a newer Recheck's atomic
    // models + provider + warnings snapshot.
    let releaseSlowInspect: (() => void) | undefined
    const slowInspectGate = new Promise<void>((resolve) => {
      releaseSlowInspect = resolve
    })
    let markSlowEntered: (() => void) | undefined
    const slowEntered = new Promise<void>((resolve) => {
      markSlowEntered = resolve
    })
    let inspectCalls = 0
    const bedrock = { id: "bedrock", label: "Amazon Bedrock" }
    const firstParty = { id: "firstParty", label: "First-party" }
    const resolveRuntime: ResolveAgentBackendRuntime = (backendId) => {
      const reg = registration(backendId)
      return Effect.succeed({
        registration: reg,
        adapter: {
          inspect: () =>
            Effect.gen(function* () {
              inspectCalls += 1
              const call = inspectCalls
              if (call === 1) {
                markSlowEntered?.()
                // First recheck blocks until the second has finished applying.
                yield* Effect.promise(() => slowInspectGate)
                return {
                  backend: reg.descriptor,
                  models: [
                    {
                      id: "stale-profile",
                      thinkingLevels: ["low"] as const,
                    },
                  ],
                  provider: firstParty,
                  warnings: ["stale warning"],
                }
              }
              return {
                backend: reg.descriptor,
                models: [
                  {
                    id: "fresh-profile",
                    thinkingLevels: ["high"] as const,
                  },
                ],
                provider: bedrock,
                warnings: ["fresh warning"],
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
          getTail: () =>
            Effect.succeed({
              availability: "unsupported" as const,
              backend: reg.descriptor,
              items: [],
              jumpHint: false,
            }),
        },
      })
    }

    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.claude,
      resolveRuntime,
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const slowRecheck = yield* Effect.forkChild(
          active.recheck(AGENT_BACKEND_IDS.claude, { cwd: "/tmp" }),
        )
        // Wait until the slow inspect has claimed generation and entered the adapter.
        yield* Effect.promise(() => slowEntered)
        const fast = yield* active.recheck(AGENT_BACKEND_IDS.claude, {
          cwd: "/tmp",
        })
        expect(fast.kind).toBe("ready")
        expect(fast.models.map((model) => model.id)).toEqual(["fresh-profile"])
        expect(fast.provider).toEqual(bedrock)
        expect(fast.warnings).toEqual(["fresh warning"])

        releaseSlowInspect?.()
        const slowResult = yield* Fiber.join(slowRecheck)
        // Stale apply discarded: cached Active status stays on the fresh snapshot.
        // The slow call returns current status (fresh), not the stale payload.
        expect(slowResult.models.map((model) => model.id)).toEqual([
          "fresh-profile",
        ])
        expect(slowResult.provider).toEqual(bedrock)
        expect(slowResult.warnings).toEqual(["fresh warning"])

        const cached = yield* active.getBackendStatus(AGENT_BACKEND_IDS.claude)
        expect(cached?.models.map((model) => model.id)).toEqual([
          "fresh-profile",
        ])
        expect(cached?.provider).toEqual(bedrock)
        expect(cached?.warnings).toEqual(["fresh warning"])
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
          getTail: () =>
            Effect.succeed({
              availability: "unsupported" as const,
              backend: reg.descriptor,
              items: [],
              jumpHint: false,
            }),
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

describe("Agent Model catalog refresh freshness", () => {
  const inspectInput = { cwd: "/tmp" as const }

  const makeMutableResolve = (options: {
    readonly models: () => ReadonlyArray<{
      id: string
      thinkingLevels: readonly string[]
    }>
    readonly inspectStarted?: () => void
    readonly inspectGate?: () => Promise<void>
    readonly failInspect?: () => boolean
    readonly inspectCount: { value: number }
  }): ResolveAgentBackendRuntime => {
    const inner = makeResolve({})
    return (backendId) =>
      inner(backendId).pipe(
        Effect.map((runtime) => ({
          ...runtime,
          adapter: {
            ...runtime.adapter,
            inspect: () =>
              Effect.gen(function* () {
                options.inspectCount.value += 1
                options.inspectStarted?.()
                if (options.inspectGate !== undefined) {
                  yield* Effect.promise(options.inspectGate)
                }
                if (options.failInspect?.() === true) {
                  return yield* Effect.fail(
                    new AgentBackendConfigError({
                      message: `${backendId} catalog inspect failed`,
                    }),
                  )
                }
                return {
                  backend: runtime.registration.descriptor,
                  models: [...options.models()],
                  provider: null,
                  warnings: [] as const,
                }
              }),
          },
        })),
      )
  }

  const runWithTestClock = <A>(
    layer: ReturnType<typeof ActiveAgentBackendLive>,
    program: Effect.Effect<A, unknown, ActiveAgentBackend>,
  ) =>
    Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
    )

  it("Preview of an Active backend publishes the inspected catalog", async () => {
    const inspectCount = { value: 0 }
    let models = [{ id: "opencode/old", thinkingLevels: ["low"] as const }]
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeMutableResolve({
        models: () => models,
        inspectCount,
      }),
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput)
        expect(
          (yield* active.getBackendStatus(
            AGENT_BACKEND_IDS.opencode,
          ))?.models.map((model) => model.id),
        ).toEqual(["opencode/old"])

        models = [
          { id: "opencode/old", thinkingLevels: ["low"] },
          { id: "azure/gpt-6-astra", thinkingLevels: ["low", "high"] },
        ]
        const preview = yield* active.preview(
          AGENT_BACKEND_IDS.opencode,
          inspectInput,
        )
        expect(preview.kind).toBe("ready")
        expect(preview.models.map((model) => model.id)).toEqual([
          "opencode/old",
          "azure/gpt-6-astra",
        ])
        expect(
          (yield* active.getBackendStatus(
            AGENT_BACKEND_IDS.opencode,
          ))?.models.map((model) => model.id),
        ).toEqual(["opencode/old", "azure/gpt-6-astra"])
      }),
    )
  })

  it("Preview of an inactive backend does not add it to the Active set", async () => {
    const inspectCount = { value: 0 }
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeMutableResolve({
        models: () => [{ id: "grok/preview", thinkingLevels: ["high"] }],
        inspectCount,
      }),
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput)
        const preview = yield* active.preview(
          AGENT_BACKEND_IDS.grok,
          inspectInput,
        )
        expect(preview.kind).toBe("ready")
        expect(preview.models[0]?.id).toBe("grok/preview")
        expect(yield* active.getBackendStatus(AGENT_BACKEND_IDS.grok)).toBe(
          null,
        )
      }),
    )
  })

  it("Save reuses a still-fresh catalog and inspects after the freshness window", async () => {
    const inspectCount = { value: 0 }
    let models = [{ id: "opencode/old", thinkingLevels: ["low"] as const }]
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeMutableResolve({
        models: () => models,
        inspectCount,
      }),
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.preview(AGENT_BACKEND_IDS.opencode, inspectInput)
        const afterOpen = inspectCount.value
        models = [{ id: "azure/gpt-6-astra", thinkingLevels: ["high"] }]

        const reused = yield* active.refreshCatalog(
          AGENT_BACKEND_IDS.opencode,
          inspectInput,
        )
        expect(inspectCount.value).toBe(afterOpen)
        expect(reused.models.map((model) => model.id)).toEqual(["opencode/old"])

        yield* TestClock.adjust(`${AGENT_MODEL_CATALOG_FRESHNESS_MS} millis`)
        const refreshed = yield* active.refreshCatalog(
          AGENT_BACKEND_IDS.opencode,
          inspectInput,
        )
        expect(inspectCount.value).toBe(afterOpen + 1)
        expect(refreshed.models.map((model) => model.id)).toEqual([
          "azure/gpt-6-astra",
        ])
        expect(
          (yield* active.getBackendStatus(
            AGENT_BACKEND_IDS.opencode,
          ))?.models.map((model) => model.id),
        ).toEqual(["azure/gpt-6-astra"])
      }),
    )
  })

  it("overlapping refreshes share one inspect", async () => {
    const inspectCount = { value: 0 }
    let releaseInspect: (() => void) | undefined
    const inspectGate = new Promise<void>((resolve) => {
      releaseInspect = resolve
    })
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeMutableResolve({
        models: () => [{ id: "opencode/shared", thinkingLevels: [] }],
        inspectCount,
        inspectStarted: () => markStarted?.(),
        inspectGate: () => inspectGate,
      }),
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const first = yield* Effect.forkChild(
          active.preview(AGENT_BACKEND_IDS.opencode, inspectInput),
        )
        yield* Effect.promise(() => started)
        const second = yield* Effect.forkChild(
          active.preview(AGENT_BACKEND_IDS.opencode, inspectInput),
        )
        yield* Effect.yieldNow
        releaseInspect?.()
        const firstResult = yield* Fiber.join(first)
        const secondResult = yield* Fiber.join(second)
        expect(inspectCount.value).toBe(1)
        expect(firstResult.models[0]?.id).toBe("opencode/shared")
        expect(secondResult.models[0]?.id).toBe("opencode/shared")
      }),
    )
  })

  it("failed Preview of an Active backend keeps the previous catalog and does not mark Unavailable", async () => {
    const inspectCount = { value: 0 }
    let failInspect = false
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime: makeMutableResolve({
        models: () => [{ id: "opencode/live", thinkingLevels: ["low"] }],
        inspectCount,
        failInspect: () => failInspect,
      }),
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput)
        failInspect = true
        const preview = yield* active.preview(
          AGENT_BACKEND_IDS.opencode,
          inspectInput,
        )
        expect(preview.kind).toBe("unavailable")
        expect(preview.reason).toContain("catalog inspect failed")
        const status = yield* active.getBackendStatus(
          AGENT_BACKEND_IDS.opencode,
        )
        expect(status?.kind).toBe("ready")
        expect(status?.models.map((model) => model.id)).toEqual([
          "opencode/live",
        ])
      }),
    )
  })

  it("failed Preview does not discard a concurrent Recheck catalog update", async () => {
    let releaseRecheck: (() => void) | undefined
    const recheckGate = new Promise<void>((resolve) => {
      releaseRecheck = resolve
    })
    let markRecheckEntered: (() => void) | undefined
    const recheckEntered = new Promise<void>((resolve) => {
      markRecheckEntered = resolve
    })
    let inspectCalls = 0
    const resolveRuntime: ResolveAgentBackendRuntime = (backendId) => {
      const reg = registration(backendId)
      return Effect.succeed({
        registration: reg,
        adapter: {
          inspect: () =>
            Effect.gen(function* () {
              inspectCalls += 1
              const call = inspectCalls
              if (call === 1) {
                return {
                  backend: reg.descriptor,
                  models: [{ id: "old-model", thinkingLevels: ["low"] }],
                }
              }
              if (call === 2) {
                markRecheckEntered?.()
                yield* Effect.promise(() => recheckGate)
                return {
                  backend: reg.descriptor,
                  models: [{ id: "recheck-model", thinkingLevels: ["high"] }],
                }
              }
              return yield* Effect.fail(
                new AgentBackendConfigError({
                  message: "preview inspect failed",
                }),
              )
            }),
          startTurn: () => Effect.die("unused"),
          continueTurn: () => Effect.die("unused"),
        },
        telemetry: {
          getSession: (sessionId: string) =>
            Effect.succeed(
              unsupportedSessionTelemetry(sessionId, reg.descriptor),
            ),
          getTail: () =>
            Effect.succeed({
              availability: "unsupported" as const,
              backend: reg.descriptor,
              items: [],
              jumpHint: false,
            }),
        },
      })
    }
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput)
        const recheckFiber = yield* Effect.forkChild(
          active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput),
        )
        yield* Effect.promise(() => recheckEntered)
        const preview = yield* active.preview(
          AGENT_BACKEND_IDS.opencode,
          inspectInput,
        )
        expect(preview.kind).toBe("unavailable")
        releaseRecheck?.()
        const rechecked = yield* Fiber.join(recheckFiber)
        expect(rechecked.kind).toBe("ready")
        expect(rechecked.models.map((model) => model.id)).toEqual([
          "recheck-model",
        ])
        expect(
          (yield* active.getBackendStatus(
            AGENT_BACKEND_IDS.opencode,
          ))?.models.map((model) => model.id),
        ).toEqual(["recheck-model"])
      }),
    )
  })

  it("publishes Recheck when it finishes inspect while a failing Preview is still in flight", async () => {
    let releaseRecheck: (() => void) | undefined
    const recheckGate = new Promise<void>((resolve) => {
      releaseRecheck = resolve
    })
    let markRecheckEntered: (() => void) | undefined
    const recheckEntered = new Promise<void>((resolve) => {
      markRecheckEntered = resolve
    })
    let markRecheckInspectDone: (() => void) | undefined
    const recheckInspectDone = new Promise<void>((resolve) => {
      markRecheckInspectDone = resolve
    })
    let releasePreview: (() => void) | undefined
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve
    })
    let markPreviewEntered: (() => void) | undefined
    const previewEntered = new Promise<void>((resolve) => {
      markPreviewEntered = resolve
    })
    let inspectCalls = 0
    const resolveRuntime: ResolveAgentBackendRuntime = (backendId) => {
      const reg = registration(backendId)
      return Effect.succeed({
        registration: reg,
        adapter: {
          inspect: () =>
            Effect.gen(function* () {
              inspectCalls += 1
              const call = inspectCalls
              if (call === 1) {
                return {
                  backend: reg.descriptor,
                  models: [{ id: "old-model", thinkingLevels: ["low"] }],
                }
              }
              if (call === 2) {
                markRecheckEntered?.()
                yield* Effect.promise(() => recheckGate)
                markRecheckInspectDone?.()
                return {
                  backend: reg.descriptor,
                  models: [{ id: "recheck-model", thinkingLevels: ["high"] }],
                }
              }
              markPreviewEntered?.()
              yield* Effect.promise(() => previewGate)
              return yield* Effect.fail(
                new AgentBackendConfigError({
                  message: "preview inspect failed",
                }),
              )
            }),
          startTurn: () => Effect.die("unused"),
          continueTurn: () => Effect.die("unused"),
        },
        telemetry: {
          getSession: (sessionId: string) =>
            Effect.succeed(
              unsupportedSessionTelemetry(sessionId, reg.descriptor),
            ),
          getTail: () =>
            Effect.succeed({
              availability: "unsupported" as const,
              backend: reg.descriptor,
              items: [],
              jumpHint: false,
            }),
        },
      })
    }
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput)
        const recheckFiber = yield* Effect.forkChild(
          active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput),
        )
        yield* Effect.promise(() => recheckEntered)
        const previewFiber = yield* Effect.forkChild(
          active.preview(AGENT_BACKEND_IDS.opencode, inspectInput),
        )
        yield* Effect.promise(() => previewEntered)
        // Recheck claimed first; Preview now holds a newer generation. Finish
        // Recheck inspect while Preview is still in flight so apply is skipped
        // unless Recheck waits for that Preview to finish.
        releaseRecheck?.()
        yield* Effect.promise(() => recheckInspectDone)
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow
        }
        releasePreview?.()
        const rechecked = yield* Fiber.join(recheckFiber)
        const preview = yield* Fiber.join(previewFiber)
        expect(preview.kind).toBe("unavailable")
        expect(rechecked.kind).toBe("ready")
        expect(rechecked.models.map((model) => model.id)).toEqual([
          "recheck-model",
        ])
        expect(
          (yield* active.getBackendStatus(
            AGENT_BACKEND_IDS.opencode,
          ))?.models.map((model) => model.id),
        ).toEqual(["recheck-model"])
      }),
    )
  })

  it("marks Unavailable when Recheck fails while a failing Preview is still in flight", async () => {
    let releaseRecheck: (() => void) | undefined
    const recheckGate = new Promise<void>((resolve) => {
      releaseRecheck = resolve
    })
    let markRecheckEntered: (() => void) | undefined
    const recheckEntered = new Promise<void>((resolve) => {
      markRecheckEntered = resolve
    })
    let markRecheckInspectDone: (() => void) | undefined
    const recheckInspectDone = new Promise<void>((resolve) => {
      markRecheckInspectDone = resolve
    })
    let releasePreview: (() => void) | undefined
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve
    })
    let markPreviewEntered: (() => void) | undefined
    const previewEntered = new Promise<void>((resolve) => {
      markPreviewEntered = resolve
    })
    let inspectCalls = 0
    const resolveRuntime: ResolveAgentBackendRuntime = (backendId) => {
      const reg = registration(backendId)
      return Effect.succeed({
        registration: reg,
        adapter: {
          inspect: () =>
            Effect.gen(function* () {
              inspectCalls += 1
              const call = inspectCalls
              if (call === 1) {
                return {
                  backend: reg.descriptor,
                  models: [{ id: "old-model", thinkingLevels: ["low"] }],
                }
              }
              if (call === 2) {
                markRecheckEntered?.()
                yield* Effect.promise(() => recheckGate)
                markRecheckInspectDone?.()
                return yield* Effect.fail(
                  new AgentBackendConfigError({
                    message: "recheck inspect failed",
                  }),
                )
              }
              markPreviewEntered?.()
              yield* Effect.promise(() => previewGate)
              return yield* Effect.fail(
                new AgentBackendConfigError({
                  message: "preview inspect failed",
                }),
              )
            }),
          startTurn: () => Effect.die("unused"),
          continueTurn: () => Effect.die("unused"),
        },
        telemetry: {
          getSession: (sessionId: string) =>
            Effect.succeed(
              unsupportedSessionTelemetry(sessionId, reg.descriptor),
            ),
          getTail: () =>
            Effect.succeed({
              availability: "unsupported" as const,
              backend: reg.descriptor,
              items: [],
              jumpHint: false,
            }),
        },
      })
    }
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput)
        const recheckFiber = yield* Effect.forkChild(
          active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput),
        )
        yield* Effect.promise(() => recheckEntered)
        const previewFiber = yield* Effect.forkChild(
          active.preview(AGENT_BACKEND_IDS.opencode, inspectInput),
        )
        yield* Effect.promise(() => previewEntered)
        releaseRecheck?.()
        yield* Effect.promise(() => recheckInspectDone)
        for (let i = 0; i < 8; i += 1) {
          yield* Effect.yieldNow
        }
        releasePreview?.()
        const rechecked = yield* Fiber.join(recheckFiber)
        const preview = yield* Fiber.join(previewFiber)
        expect(preview.kind).toBe("unavailable")
        expect(rechecked.kind).toBe("unavailable")
        expect(rechecked.reason).toContain("recheck inspect failed")
        const status = yield* active.getBackendStatus(
          AGENT_BACKEND_IDS.opencode,
        )
        expect(status?.kind).toBe("unavailable")
        expect(status?.reason).toContain("recheck inspect failed")
      }),
    )
  })

  it("does not let a slower Preview overwrite a Recheck that already finished", async () => {
    let releasePreview: (() => void) | undefined
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve
    })
    let markPreviewEntered: (() => void) | undefined
    const previewEntered = new Promise<void>((resolve) => {
      markPreviewEntered = resolve
    })
    let inspectCalls = 0
    const resolveRuntime: ResolveAgentBackendRuntime = (backendId) => {
      const reg = registration(backendId)
      return Effect.succeed({
        registration: reg,
        adapter: {
          inspect: () =>
            Effect.gen(function* () {
              inspectCalls += 1
              const call = inspectCalls
              if (call === 1) {
                return {
                  backend: reg.descriptor,
                  models: [{ id: "old-model", thinkingLevels: ["low"] }],
                }
              }
              if (call === 2) {
                markPreviewEntered?.()
                yield* Effect.promise(() => previewGate)
                return {
                  backend: reg.descriptor,
                  models: [
                    { id: "stale-preview-model", thinkingLevels: ["low"] },
                  ],
                }
              }
              return {
                backend: reg.descriptor,
                models: [{ id: "recheck-model", thinkingLevels: ["high"] }],
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
          getTail: () =>
            Effect.succeed({
              availability: "unsupported" as const,
              backend: reg.descriptor,
              items: [],
              jumpHint: false,
            }),
        },
      })
    }
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        yield* active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput)
        const previewFiber = yield* Effect.forkChild(
          active.preview(AGENT_BACKEND_IDS.opencode, inspectInput),
        )
        yield* Effect.promise(() => previewEntered)
        const rechecked = yield* active.recheck(
          AGENT_BACKEND_IDS.opencode,
          inspectInput,
        )
        expect(rechecked.models.map((model) => model.id)).toEqual([
          "recheck-model",
        ])
        releasePreview?.()
        const preview = yield* Fiber.join(previewFiber)
        // Settings dropdown uses this Preview payload; it must match the
        // published Recheck catalog Save and Agent Turns will use.
        expect(preview.kind).toBe("ready")
        expect(preview.models.map((model) => model.id)).toEqual([
          "recheck-model",
        ])
        expect(
          (yield* active.getBackendStatus(
            AGENT_BACKEND_IDS.opencode,
          ))?.models.map((model) => model.id),
        ).toEqual(["recheck-model"])
      }),
    )
  })

  it("discards a slower catalog refresh after a newer inspect", async () => {
    let releaseSlow: (() => void) | undefined
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let markSlowEntered: (() => void) | undefined
    const slowEntered = new Promise<void>((resolve) => {
      markSlowEntered = resolve
    })
    let inspectCalls = 0
    const resolveRuntime: ResolveAgentBackendRuntime = (backendId) => {
      const reg = registration(backendId)
      return Effect.succeed({
        registration: reg,
        adapter: {
          inspect: () =>
            Effect.gen(function* () {
              inspectCalls += 1
              const call = inspectCalls
              if (call === 1) {
                markSlowEntered?.()
                yield* Effect.promise(() => slowGate)
                return {
                  backend: reg.descriptor,
                  models: [{ id: "stale-model", thinkingLevels: ["low"] }],
                }
              }
              return {
                backend: reg.descriptor,
                models: [{ id: "fresh-model", thinkingLevels: ["high"] }],
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
          getTail: () =>
            Effect.succeed({
              availability: "unsupported" as const,
              backend: reg.descriptor,
              items: [],
              jumpHint: false,
            }),
        },
      })
    }
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const slow = yield* Effect.forkChild(
          active.recheck(AGENT_BACKEND_IDS.opencode, inspectInput),
        )
        yield* Effect.promise(() => slowEntered)
        const fast = yield* active.preview(
          AGENT_BACKEND_IDS.opencode,
          inspectInput,
        )
        expect(fast.models.map((model) => model.id)).toEqual(["fresh-model"])
        releaseSlow?.()
        yield* Fiber.join(slow)
        expect(
          (yield* active.getBackendStatus(
            AGENT_BACKEND_IDS.opencode,
          ))?.models.map((model) => model.id),
        ).toEqual(["fresh-model"])
      }),
    )
  })

  it("does not re-activate a backend that left the Active set during refresh", async () => {
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
          getTail: () =>
            Effect.succeed({
              availability: "unsupported" as const,
              backend: reg.descriptor,
              items: [],
              jumpHint: false,
            }),
        },
      })
    }
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })

    await runWithTestClock(
      layer,
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const previewFiber = yield* Effect.forkChild(
          active.preview(AGENT_BACKEND_IDS.opencode, inspectInput),
        )
        yield* Effect.yieldNow
        yield* active.setSelectedOrInUse([AGENT_BACKEND_IDS.grok], inspectInput)
        releaseInspect?.()
        const preview = yield* Fiber.join(previewFiber)
        expect(preview.kind).toBe("ready")
        expect(preview.models[0]?.id).toBe("opencode/model-a")
        expect(yield* active.getBackendStatus(AGENT_BACKEND_IDS.opencode)).toBe(
          null,
        )
        const statuses = yield* active.listStatuses
        expect(statuses.map((status) => status.backend.id)).toEqual(["grok"])
      }),
    )
  })
})

describe("inspectStartupBackend malformed-output confirmation", () => {
  type SequencedInspect =
    | { kind: "ready" }
    | { kind: "fail"; error: () => AgentBackendError }

  const makeSequencedResolve = (
    inspectResults: ReadonlyArray<SequencedInspect>,
  ): {
    resolveRuntime: ResolveAgentBackendRuntime
    inspectCount: () => number
  } => {
    let inspectCount = 0
    const resolveRuntime: ResolveAgentBackendRuntime = (backendId) => {
      const reg = registration(backendId)
      return Effect.succeed({
        registration: reg,
        adapter: {
          inspect: () => {
            const index = Math.min(inspectCount, inspectResults.length - 1)
            inspectCount += 1
            const result = inspectResults[index]
            if (result === undefined || result.kind === "ready") {
              return Effect.succeed({
                backend: reg.descriptor,
                models: [
                  {
                    id: `${backendId}/model-a`,
                    thinkingLevels: ["low", "high"],
                  },
                ],
                provider: null,
                warnings: [],
              })
            }
            return Effect.fail(result.error())
          },
          startTurn: () => Effect.succeed(turnResult(`${backendId}-start`)),
          continueTurn: () =>
            Effect.succeed(turnResult(`${backendId}-continue`)),
        },
        telemetry: {
          getSession: (sessionId: string) =>
            Effect.succeed(
              unsupportedSessionTelemetry(sessionId, reg.descriptor),
            ),
          getTail: () =>
            Effect.succeed({
              availability: "unsupported" as const,
              backend: reg.descriptor,
              items: [],
              jumpHint: false,
            }),
        },
      })
    }
    return { resolveRuntime, inspectCount: () => inspectCount }
  }

  const malformed = () =>
    new AgentBackendMalformedOutputError({ cwd: "/tmp", byteLength: 3 })

  it("confirms a transient malformed startup inspection and leaves the backend Ready", async () => {
    const { resolveRuntime, inspectCount } = makeSequencedResolve([
      { kind: "fail", error: malformed },
      { kind: "ready" },
    ])
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const status = yield* active.inspectStartupBackend(
          AGENT_BACKEND_IDS.opencode,
          { cwd: "/tmp" },
        )
        expect(status.kind).toBe("ready")
        expect(status.backend.id).toBe("opencode")
        expect(inspectCount()).toBe(2)
        expect(
          (yield* active.getBackendStatus(AGENT_BACKEND_IDS.opencode))?.kind,
        ).toBe("ready")
      }).pipe(Effect.provide(layer)),
    )
  })

  it("keeps the backend Unavailable after two malformed results with exactly two attempts", async () => {
    const { resolveRuntime, inspectCount } = makeSequencedResolve([
      { kind: "fail", error: malformed },
      { kind: "fail", error: malformed },
    ])
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const status = yield* active.inspectStartupBackend(
          AGENT_BACKEND_IDS.opencode,
          { cwd: "/tmp" },
        )
        expect(status.kind).toBe("unavailable")
        expect(status.reason).toContain("AgentBackendMalformedOutputError")
        expect(inspectCount()).toBe(2)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("does not retry non-malformed inspect failures", async () => {
    const { resolveRuntime, inspectCount } = makeSequencedResolve([
      {
        kind: "fail",
        error: () => new AgentBackendConfigError({ message: "binary missing" }),
      },
    ])
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const status = yield* active.inspectStartupBackend(
          AGENT_BACKEND_IDS.opencode,
          { cwd: "/tmp" },
        )
        expect(status.kind).toBe("unavailable")
        expect(status.reason).toContain("binary missing")
        expect(inspectCount()).toBe(1)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("explicit recheck stays single-attempt for malformed output", async () => {
    const { resolveRuntime, inspectCount } = makeSequencedResolve([
      { kind: "fail", error: malformed },
      { kind: "ready" },
    ])
    const layer = ActiveAgentBackendLive({
      selectedBackendId: AGENT_BACKEND_IDS.opencode,
      resolveRuntime,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const status = yield* active.recheck(AGENT_BACKEND_IDS.opencode, {
          cwd: "/tmp",
        })
        expect(status.kind).toBe("unavailable")
        expect(inspectCount()).toBe(1)
      }).pipe(Effect.provide(layer)),
    )
  })
})
