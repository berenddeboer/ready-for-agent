import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  ActiveAgentBackendLive,
  type AgentBackendError,
  type AgentBackendId,
  AgentBackendMalformedOutputError,
  type ResolveAgentBackendRuntime,
  getBuiltInAgentBackend,
  unsupportedSessionTelemetry,
} from "@ready-for-agent/agent-backend"
import { stubDbServiceLayer } from "@ready-for-agent/db-service/test"
import { inspectBackendsAtStartup } from "../src/server/startup-backend-inspection.js"
import { describe, expect, it } from "bun:test"

type SequencedInspect =
  | { kind: "ready" }
  | { kind: "fail"; error: () => AgentBackendError }

const readyInspect = (backendId: AgentBackendId) => ({
  backend: getBuiltInAgentBackend(backendId)!.descriptor,
  models: [{ id: `${backendId}/model-a`, thinkingLevels: ["low", "high"] }],
  provider: null,
  warnings: [],
})

const makeResolveWithSequences =
  (
    sequences: Record<string, ReadonlyArray<SequencedInspect>>,
    counters: Record<string, number>,
  ): ResolveAgentBackendRuntime =>
  (backendId) => {
    const reg = getBuiltInAgentBackend(backendId)
    if (reg === undefined) {
      throw new Error(`missing registration ${backendId}`)
    }
    return Effect.succeed({
      registration: reg,
      adapter: {
        inspect: () => {
          const seq = sequences[backendId] ?? [{ kind: "ready" as const }]
          const n = counters[backendId] ?? 0
          counters[backendId] = n + 1
          const result = seq[Math.min(n, seq.length - 1)]
          if (result === undefined || result.kind === "ready") {
            return Effect.succeed(readyInspect(backendId))
          }
          return Effect.fail(result.error())
        },
        startTurn: () =>
          Effect.succeed({ sessionId: `${backendId}-s`, assistantText: "ok" }),
        continueTurn: () =>
          Effect.succeed({ sessionId: `${backendId}-s`, assistantText: "ok" }),
      },
      telemetry: {
        getSession: (id: string) =>
          Effect.succeed(unsupportedSessionTelemetry(id, reg.descriptor)),
      },
    })
  }

const malformed = () =>
  new AgentBackendMalformedOutputError({ cwd: "/tmp", byteLength: 3 })

const makeLayer = (
  opencodeSequence: ReadonlyArray<SequencedInspect>,
  counters: Record<string, number>,
) =>
  ActiveAgentBackendLive({
    selectedBackendId: AGENT_BACKEND_IDS.opencode,
    resolveRuntime: makeResolveWithSequences(
      {
        opencode: opencodeSequence,
        claude: [{ kind: "ready" }],
        codex: [{ kind: "ready" }],
        grok: [{ kind: "ready" }],
      },
      counters,
    ),
  })

const run = (
  opencodeSequence: ReadonlyArray<SequencedInspect>,
  counters: Record<string, number>,
) =>
  Effect.gen(function* () {
    const active = yield* ActiveAgentBackend
    const guidance = yield* inspectBackendsAtStartup({
      cwd: "/tmp",
      inspectTimeout: "30 seconds",
      previewTimeout: "8 seconds",
    })
    return {
      guidance,
      status: yield* active.getBackendStatus(AGENT_BACKEND_IDS.opencode),
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        makeLayer(opencodeSequence, counters),
        stubDbServiceLayer(),
      ),
    ),
  )

describe("inspectBackendsAtStartup default-backend guidance", () => {
  it("suppresses guidance after a confirmed transient malformed output", async () => {
    const counters: Record<string, number> = {}
    const result = await Effect.runPromise(
      run([{ kind: "fail", error: malformed }, { kind: "ready" }], counters),
    )

    expect(result.status?.kind).toBe("ready")
    expect(result.guidance).toBeNull()
    expect(counters.opencode).toBe(2)
  })

  it("emits guidance when malformed output persists across the confirmation", async () => {
    const counters: Record<string, number> = {}
    const result = await Effect.runPromise(
      run(
        [
          { kind: "fail", error: malformed },
          { kind: "fail", error: malformed },
        ],
        counters,
      ),
    )

    expect(result.status?.kind).toBe("unavailable")
    expect(result.guidance).not.toBeNull()
    expect(result.guidance).toContain(
      "Default Agent Backend 'opencode' is not available",
    )
    expect(counters.opencode).toBe(2)
  })
})
