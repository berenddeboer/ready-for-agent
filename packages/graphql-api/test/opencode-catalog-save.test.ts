import { Effect } from "effect"
import { TestClock } from "effect/testing"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  ActiveAgentBackendLive,
  OPENCODE_AGENT_MODEL_CATALOG_FRESHNESS_MS,
  type ResolveAgentBackendRuntime,
  getBuiltInAgentBackend,
  unsupportedSessionTelemetry,
} from "@ready-for-agent/agent-backend"
import { validateAgentModelsAgainstCatalog } from "../src/lib/validate-agent-models.js"
import { describe, expect, it } from "bun:test"

class CatalogRejection {
  readonly _tag = "CatalogRejection"
  constructor(
    readonly field: string,
    readonly message: string,
  ) {}
}

const registration = (id: string) => {
  const found = getBuiltInAgentBackend(id)
  if (found === undefined) {
    throw new Error(`missing registration ${id}`)
  }
  return found
}

describe("Save against a cached OpenCode catalog", () => {
  it("accepts a cached model without a second inspect and rejects a model that is not in that catalog", async () => {
    const cached = {
      id: "opencode/cached",
      name: "Cached",
      thinkingLevels: ["low", "high"] as const,
    }
    let models = [cached]
    let inspectCount = 0
    const resolveRuntime: ResolveAgentBackendRuntime = (backendId) => {
      const reg = registration(backendId)
      return Effect.succeed({
        registration: reg,
        adapter: {
          inspect: () =>
            Effect.sync(() => {
              inspectCount += 1
              return {
                backend: reg.descriptor,
                models: [...models],
                provider: null,
                warnings: [] as const,
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
    const inspectInput = { cwd: "/tmp", timeout: "30 seconds" } as const

    await Effect.runPromise(
      Effect.gen(function* () {
        const active = yield* ActiveAgentBackend
        const preview = yield* active.preview(
          AGENT_BACKEND_IDS.opencode,
          inspectInput,
        )
        expect(preview.models).toEqual([cached])
        const afterPreview = inspectCount
        models = [
          {
            id: "opencode/later",
            name: "Later",
            thinkingLevels: ["high"] as const,
          },
        ]

        yield* validateAgentModelsAgainstCatalog({
          backendId: "opencode",
          inspectInput,
          models: { defaultModel: "opencode/cached" },
          thinking: {
            scope: "harness",
            submitted: {
              defaultModel: "opencode/cached",
              defaultThinkingLevel: "high",
              reviewModel: null,
              reviewThinkingLevel: null,
            },
            harness: {
              defaultModel: "opencode/cached",
              defaultThinkingLevel: "high",
              reviewModel: null,
              reviewThinkingLevel: null,
            },
          },
          onInvalid: (field, message) => new CatalogRejection(field, message),
        })
        expect(inspectCount).toBe(afterPreview)

        const rejected = yield* Effect.result(
          validateAgentModelsAgainstCatalog({
            backendId: "opencode",
            inspectInput,
            models: { defaultModel: "opencode/later" },
            onInvalid: (field, message) => new CatalogRejection(field, message),
          }),
        )
        expect(rejected._tag).toBe("Failure")
        if (rejected._tag === "Failure") {
          expect(rejected.failure.field).toBe("defaultModel")
          expect(rejected.failure.message).toContain("not in the current")
        }
        expect(inspectCount).toBe(afterPreview)

        yield* TestClock.adjust(
          `${OPENCODE_AGENT_MODEL_CATALOG_FRESHNESS_MS} millis`,
        )
        yield* validateAgentModelsAgainstCatalog({
          backendId: "opencode",
          inspectInput,
          models: { defaultModel: "opencode/later" },
          onInvalid: (field, message) => new CatalogRejection(field, message),
        })
        expect(inspectCount).toBe(afterPreview + 1)
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
    )
  })
})
