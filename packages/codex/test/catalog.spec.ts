import {
  projectAppServerModelList,
  projectBundledDebugModels,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("projectAppServerModelList", () => {
  it("keeps Astra's executable id, display name, and advertised efforts including max/ultra", () => {
    const result = projectAppServerModelList({
      data: [
        {
          model: "gpt-6-astra",
          displayName: "GPT-6 Astra",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
            { reasoningEffort: "xhigh" },
            { reasoningEffort: "max" },
            { reasoningEffort: "ultra" },
          ],
        },
      ],
    })

    expect(result).toEqual({
      kind: "ok",
      models: [
        {
          id: "gpt-6-astra",
          name: "GPT-6 Astra",
          thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      ],
    })
  })

  it("accepts an unseen model id and unfamiliar reasoning token without a Harness allowlist", () => {
    const result = projectAppServerModelList({
      data: [
        {
          model: "gpt-9-zenith",
          displayName: "GPT-9 Zenith",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "spark" },
            { reasoningEffort: "max" },
          ],
        },
      ],
    })

    expect(result).toEqual({
      kind: "ok",
      models: [
        {
          id: "gpt-9-zenith",
          name: "GPT-9 Zenith",
          thinkingLevels: ["spark", "max"],
        },
      ],
    })
  })

  it("excludes hidden entries, preserves advertised order, and allows empty effort lists", () => {
    const result = projectAppServerModelList({
      data: [
        {
          model: "gpt-daybreak-blue-latest",
          displayName: "Daybreak Blue",
          hidden: true,
          supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
        },
        {
          model: "gpt-6-astra",
          displayName: "GPT-6 Astra",
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        },
        {
          model: "legacy-no-effort",
          displayName: "Legacy",
          hidden: false,
          supportedReasoningEfforts: [],
        },
      ],
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.models.map((model) => model.id)).toEqual([
        "gpt-6-astra",
        "legacy-no-effort",
      ])
      expect(result.models[1]?.thinkingLevels).toEqual([])
    }
  })

  it("deduplicates by executable model id, keeping the first advertised entry", () => {
    const result = projectAppServerModelList({
      data: [
        {
          model: "gpt-6-astra",
          displayName: "First",
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        },
        {
          model: "gpt-6-astra",
          displayName: "Second",
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "ultra" }],
        },
      ],
    })

    expect(result).toEqual({
      kind: "ok",
      models: [
        {
          id: "gpt-6-astra",
          name: "First",
          thinkingLevels: ["low"],
        },
      ],
    })
  })

  it("uses model as the executable id even when it differs from id", () => {
    const result = projectAppServerModelList({
      data: [
        {
          id: "preset-astra",
          model: "gpt-6-astra",
          displayName: "GPT-6 Astra",
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        },
      ],
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.models[0]?.id).toBe("gpt-6-astra")
    }
  })

  it("reports empty when every entry is hidden or unusable", () => {
    const result = projectAppServerModelList({
      data: [
        {
          model: "gpt-daybreak-red-latest",
          displayName: "Daybreak Red",
          hidden: true,
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        },
        { displayName: "Missing model field", hidden: false },
      ],
    })

    expect(result).toEqual({ kind: "empty" })
  })

  it("reports malformed when the page is not a model/list payload", () => {
    expect(projectAppServerModelList(null)).toEqual({
      kind: "malformed",
      reason: "model/list response is not an object",
    })
    expect(projectAppServerModelList({ models: [] })).toEqual({
      kind: "malformed",
      reason: "model/list data is not an array",
    })
  })
})

describe("projectBundledDebugModels", () => {
  it("includes Astra and other picker-visible bundled entries, excluding hidden Daybreak", () => {
    const result = projectBundledDebugModels({
      models: [
        {
          slug: "gpt-6-astra",
          display_name: "GPT-6-Astra",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "max" },
            { effort: "ultra" },
          ],
        },
        {
          slug: "gpt-daybreak-blue-latest",
          display_name: "Daybreak Blue",
          visibility: "hide",
          supported_in_api: true,
          priority: 2,
          supported_reasoning_levels: [{ effort: "ultra" }],
        },
        {
          slug: "gpt-5.6-terra",
          display_name: "GPT-5.6-Terra",
          visibility: "list",
          supported_in_api: true,
          priority: 7,
          supported_reasoning_levels: [{ effort: "high" }],
        },
      ],
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.models.map((model) => model.id)).toEqual([
        "gpt-6-astra",
        "gpt-5.6-terra",
      ])
      expect(result.models[0]).toEqual({
        id: "gpt-6-astra",
        name: "GPT-6-Astra",
        thinkingLevels: ["low", "max", "ultra"],
      })
    }
  })

  it("sorts by advertised priority and keeps an unfamiliar bundled slug", () => {
    const result = projectBundledDebugModels({
      models: [
        {
          slug: "custom-zenith",
          display_name: "Zenith",
          visibility: "list",
          supported_in_api: true,
          priority: 40,
          supported_reasoning_levels: [{ effort: "spark" }],
        },
        {
          slug: "gpt-6-astra",
          display_name: "GPT-6-Astra",
          visibility: "list",
          supported_in_api: true,
          priority: 1,
          supported_reasoning_levels: [],
        },
      ],
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.models.map((model) => model.id)).toEqual([
        "gpt-6-astra",
        "custom-zenith",
      ])
      expect(result.models[0]?.thinkingLevels).toEqual([])
      expect(result.models[1]?.thinkingLevels).toEqual(["spark"])
    }
  })

  it("drops entries that are not API-supported, matching custom-provider picker filtering", () => {
    const result = projectBundledDebugModels({
      models: [
        {
          slug: "chatgpt-only",
          display_name: "ChatGPT Only",
          visibility: "list",
          supported_in_api: false,
          priority: 1,
          supported_reasoning_levels: [{ effort: "low" }],
        },
        {
          slug: "gpt-6-astra",
          display_name: "GPT-6-Astra",
          visibility: "list",
          supported_in_api: true,
          priority: 2,
          supported_reasoning_levels: [{ effort: "low" }],
        },
      ],
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.models.map((model) => model.id)).toEqual(["gpt-6-astra"])
    }
  })

  it("reports empty when the bundle has no picker-visible models", () => {
    const result = projectBundledDebugModels({
      models: [
        {
          slug: "gpt-daybreak-red-latest",
          display_name: "Daybreak Red",
          visibility: "hide",
          supported_in_api: true,
          priority: 1,
          supported_reasoning_levels: [{ effort: "low" }],
        },
      ],
    })

    expect(result).toEqual({ kind: "empty" })
  })

  it("reports malformed when bundled JSON is not {models: [...]}", () => {
    expect(projectBundledDebugModels("not json")).toEqual({
      kind: "malformed",
      reason: "bundled models output is not JSON",
    })
    expect(projectBundledDebugModels({ data: [] })).toEqual({
      kind: "malformed",
      reason: "bundled models output is missing a models array",
    })
  })
})
