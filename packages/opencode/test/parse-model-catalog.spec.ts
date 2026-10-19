import {
  OPENCODE_CATALOG_EMPTY_MESSAGE,
  parseOpencodeModelCatalog,
} from "../src/lib/parse-model-catalog.js"
import { describe, expect, it } from "bun:test"

const envelope = (
  data: ReadonlyArray<unknown>,
  directory = "/work/repo",
): string =>
  JSON.stringify({
    location: { directory },
    data,
  })

const model = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "grok-4.5",
  modelID: "grok-4.5",
  providerID: "xai",
  name: "Grok 4.5",
  enabled: true,
  variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
  ...overrides,
})

describe("parseOpencodeModelCatalog", () => {
  it("maps provider-prefixed ids, names, and variant ids", () => {
    const parsed = parseOpencodeModelCatalog(
      envelope([
        model(),
        model({
          id: "accounts/fireworks/models/deepseek-v4p1-flash",
          modelID: "accounts/fireworks/models/deepseek-v4p1-flash",
          providerID: "fireworks-ai",
          name: "DeepSeek V4.1 Flash",
          variants: [{ id: "low", settings: { reasoningEffort: "low" } }],
        }),
        model({
          id: "gpt-6.1-sol-ultrafast",
          modelID: "gpt-6.1-sol",
          providerID: "openai",
          name: "GPT-6.1 Sol Ultrafast",
          variants: [{ id: "max" }],
        }),
        model({
          id: "non-reasoning",
          modelID: "non-reasoning",
          providerID: "xai",
          name: "   ",
          variants: [],
        }),
      ]),
    )

    expect(parsed).toEqual({
      kind: "ok",
      models: [
        {
          id: "xai/grok-4.5",
          name: "Grok 4.5",
          thinkingLevels: ["low", "medium", "high"],
        },
        {
          id: "fireworks-ai/accounts/fireworks/models/deepseek-v4p1-flash",
          name: "DeepSeek V4.1 Flash",
          thinkingLevels: ["low"],
        },
        {
          id: "openai/gpt-6.1-sol-ultrafast",
          name: "GPT-6.1 Sol Ultrafast",
          thinkingLevels: ["max"],
        },
        {
          id: "xai/non-reasoning",
          thinkingLevels: [],
        },
      ],
    })
  })

  it("keeps only enabled models and the first duplicate executable id", () => {
    const parsed = parseOpencodeModelCatalog(
      envelope([
        model({
          id: "disabled-model",
          modelID: "disabled-model",
          name: "Disabled",
          enabled: false,
          variants: [{ id: "low" }],
        }),
        model({ id: "kept", modelID: "kept", name: "First" }),
        model({
          id: "kept",
          modelID: "kept-wire",
          name: "Second",
          variants: [{ id: "max" }],
        }),
      ]),
    )

    expect(parsed).toEqual({
      kind: "ok",
      models: [
        {
          id: "xai/kept",
          name: "First",
          thinkingLevels: ["low", "medium", "high"],
        },
      ],
    })
  })

  it("dedupes variant ids and preserves the first advertised order", () => {
    const parsed = parseOpencodeModelCatalog(
      envelope([
        model({
          variants: [{ id: "high" }, { id: " high " }, { id: "low" }],
        }),
      ]),
    )

    expect(parsed).toEqual({
      kind: "ok",
      models: [
        {
          id: "xai/grok-4.5",
          name: "Grok 4.5",
          thinkingLevels: ["high", "low"],
        },
      ],
    })
  })

  it("rejects the pre-V2 variants map instead of inventing Thinking Levels", () => {
    const parsed = parseOpencodeModelCatalog(
      envelope([
        model({
          variants: { low: {}, high: {} },
        }),
      ]),
    )

    expect(parsed).toEqual({
      kind: "malformed",
      reason: "response does not match the V2 /api/model envelope",
    })
  })

  it("rejects envelopes that are not the V2 model list", () => {
    expect(parseOpencodeModelCatalog("")).toEqual({
      kind: "malformed",
      reason: "stdout is empty",
    })
    expect(parseOpencodeModelCatalog("not-json")).toEqual({
      kind: "malformed",
      reason: "stdout is not JSON",
    })
    expect(parseOpencodeModelCatalog("xai/grok-4.5\n{\n}\n")).toEqual({
      kind: "malformed",
      reason: "stdout is not JSON",
    })
    expect(parseOpencodeModelCatalog('{"data":[]}')).toEqual({
      kind: "malformed",
      reason: "response does not match the V2 /api/model envelope",
    })
    expect(
      parseOpencodeModelCatalog(
        JSON.stringify({ location: { directory: "/tmp" }, data: {} }),
      ),
    ).toEqual({
      kind: "malformed",
      reason: "response does not match the V2 /api/model envelope",
    })
  })

  it("rejects an enabled model whose selector would be ambiguous", () => {
    expect(
      parseOpencodeModelCatalog(
        envelope([
          model({ providerID: "open/router", id: "gpt", modelID: "gpt" }),
        ]),
      ),
    ).toEqual({
      kind: "malformed",
      reason: "an enabled model has no usable provider/model identity",
    })
    expect(
      parseOpencodeModelCatalog(
        envelope([model({ id: "gpt#high", modelID: "gpt" })]),
      ),
    ).toEqual({
      kind: "malformed",
      reason: "an enabled model has no usable provider/model identity",
    })
  })

  it("reports an empty or all-disabled catalog as unusable", () => {
    expect(parseOpencodeModelCatalog(envelope([]))).toEqual({
      kind: "empty",
    })
    expect(
      parseOpencodeModelCatalog(envelope([model({ enabled: false })])),
    ).toEqual({ kind: "empty" })
    expect(OPENCODE_CATALOG_EMPTY_MESSAGE).toContain("no enabled models")
  })
})
