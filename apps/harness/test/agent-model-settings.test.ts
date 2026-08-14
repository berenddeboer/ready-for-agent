import {
  AGENT_MODEL_KIND_APPLICATION,
  AGENT_MODEL_KIND_SYSTEM_DEFINED,
  CLAUDE_AGENT_BACKEND_ID,
  CLAUDE_BEDROCK_CONFIGURATION_MODE,
  agentModelCatalogNotice,
  agentModelSaveBlockReason,
  blocksAgentModelSave,
  blocksThinkingLevelSave,
  emptyThinkingLevelOptionLabel,
  findCatalogModel,
  formatAgentModelKindLabel,
  formatAgentModelLabel,
  formatUnavailableVariantLabel,
  governingReviewModelId,
  isClaudeBedrockConfigurationMode,
  isUnavailableCatalogModel,
  reconcileVariantForModel,
  thinkingLevelSaveBlockReason,
  thinkingLevelsForModel,
} from "../src/agent-model-settings.js"
import { describe, expect, test } from "bun:test"

const CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const

/** First-party Claude Code static aliases (adapter catalog). */
const claudeCatalog = [
  { id: "haiku", thinkingLevels: [...CLAUDE_EFFORT] },
  { id: "sonnet", thinkingLevels: [...CLAUDE_EFFORT] },
  { id: "opus", thinkingLevels: [...CLAUDE_EFFORT] },
  { id: "fable", thinkingLevels: [...CLAUDE_EFFORT] },
] as const

const opencodeCatalog = [
  { id: "opencode/deepseek-v4-flash-free", thinkingLevels: ["high", "max"] },
  { id: "opencode/gpt-5", thinkingLevels: [] },
] as const

const systemProfileId = "us.anthropic.claude-sonnet-4-6"
const applicationArn =
  "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/my-org-sonnet"

const bedrockCatalog = [
  {
    id: systemProfileId,
    thinkingLevels: [...CLAUDE_EFFORT],
    name: "US Anthropic Claude Sonnet 4.6",
    kind: AGENT_MODEL_KIND_SYSTEM_DEFINED,
  },
  {
    id: applicationArn,
    thinkingLevels: [...CLAUDE_EFFORT],
    name: "My Org Sonnet",
    kind: AGENT_MODEL_KIND_APPLICATION,
  },
] as const

const ready = (models: readonly { id: string }[]) => ({
  catalogLoading: false,
  catalogFailed: false,
  catalogModels: models as never,
})

const bedrockScope = {
  backendId: CLAUDE_AGENT_BACKEND_ID,
  configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
}
const firstPartyClaudeScope = {
  backendId: CLAUDE_AGENT_BACKEND_ID,
  configurationMode: null,
}
const opencodeScope = { backendId: "opencode", configurationMode: null }

describe("catalog-only Agent Model selection (issue #838)", () => {
  test("every backend requires catalog membership for an explicit model", () => {
    for (const [catalog, present, absent] of [
      [claudeCatalog, "sonnet", "us.anthropic.claude-sonnet-4-6"],
      [opencodeCatalog, "opencode/gpt-5", "anthropic/claude-sonnet-4-5"],
      [bedrockCatalog, systemProfileId, "sonnet"],
    ] as const) {
      const catalogModelIds = catalog.map((model) => model.id)
      expect(
        isUnavailableCatalogModel({ modelId: present, catalogModelIds }),
      ).toBe(false)
      expect(
        isUnavailableCatalogModel({ modelId: absent, catalogModelIds }),
      ).toBe(true)
    }
  })

  test("an empty model is never treated as unavailable", () => {
    expect(
      isUnavailableCatalogModel({
        modelId: "",
        catalogModelIds: claudeCatalog.map((model) => model.id),
      }),
    ).toBe(false)
  })

  test("first-party Claude no longer accepts non-catalog strings", () => {
    // Superseded #806: a Claude-accepted alias outside the catalog is blocked
    // in Settings instead of being stored and failing later at CLI time.
    const input = {
      ...ready(claudeCatalog),
      modelId: "claude-sonnet-4-5-20250929",
      requireSelection: true,
    }
    expect(blocksAgentModelSave(input)).toBe(true)
    expect(
      agentModelSaveBlockReason({ ...input, ...firstPartyClaudeScope }),
    ).toMatch(/not in the current Agent Model catalog/)
  })

  test("a catalog selection saves for every backend", () => {
    expect(
      blocksAgentModelSave({
        ...ready(claudeCatalog),
        modelId: "opus",
        requireSelection: true,
      }),
    ).toBe(false)
    expect(
      blocksAgentModelSave({
        ...ready(opencodeCatalog),
        modelId: "opencode/gpt-5",
        requireSelection: true,
      }),
    ).toBe(false)
    for (const modelId of [systemProfileId, applicationArn]) {
      expect(
        blocksAgentModelSave({
          ...ready(bedrockCatalog),
          modelId,
          requireSelection: true,
        }),
      ).toBe(false)
    }
  })
})

describe("Save gating by catalog state (issue #838)", () => {
  test("a loading catalog cannot validate an explicit model", () => {
    const input = {
      catalogLoading: true,
      catalogModels: undefined,
      modelId: "sonnet",
      requireSelection: false,
    }
    expect(blocksAgentModelSave(input)).toBe(true)
    expect(agentModelSaveBlockReason({ ...input, ...opencodeScope })).toMatch(
      /Loading the Agent Model catalog/,
    )
    expect(agentModelSaveBlockReason({ ...input, ...bedrockScope })).toMatch(
      /Loading Bedrock inference profiles/,
    )
  })

  test("a failed catalog cannot validate an explicit model", () => {
    const input = {
      catalogLoading: false,
      catalogFailed: true,
      catalogModels: undefined,
      modelId: systemProfileId,
      requireSelection: true,
    }
    expect(blocksAgentModelSave(input)).toBe(true)
    expect(agentModelSaveBlockReason({ ...input, ...opencodeScope })).toMatch(
      /Could not load the Agent Model catalog/,
    )
    expect(agentModelSaveBlockReason({ ...input, ...bedrockScope })).toMatch(
      /Could not load the Bedrock profile catalog/,
    )
  })

  test("an empty catalog blocks and points at Recheck", () => {
    const input = {
      ...ready([]),
      modelId: "",
      requireSelection: true,
    }
    expect(blocksAgentModelSave(input)).toBe(true)
    expect(agentModelSaveBlockReason({ ...input, ...opencodeScope })).toMatch(
      /No Agent Models are available/,
    )
    expect(agentModelSaveBlockReason({ ...input, ...bedrockScope })).toMatch(
      /No active Anthropic-backed Bedrock inference profiles/,
    )
    // A discovery warning is more actionable than the generic wording.
    expect(
      agentModelSaveBlockReason({
        ...input,
        ...bedrockScope,
        discoveryWarnings: [
          "Could not list Amazon Bedrock inference profiles: access denied.",
        ],
      }),
    ).toMatch(/access denied/)
  })

  test("Harness Config requires a build model; review model stays optional", () => {
    const required = {
      ...ready(claudeCatalog),
      modelId: "",
      requireSelection: true,
    }
    expect(blocksAgentModelSave(required)).toBe(true)
    expect(
      agentModelSaveBlockReason({ ...required, ...firstPartyClaudeScope }),
    ).toMatch(/Select a model from the Agent Model catalog/)
    expect(agentModelSaveBlockReason({ ...required, ...bedrockScope })).toMatch(
      /Select a discovered Bedrock inference profile/,
    )
    expect(blocksAgentModelSave({ ...required, requireSelection: false })).toBe(
      false,
    )
  })

  test("an empty Repository override saves even without a healthy catalog", () => {
    // Inheritance has nothing to validate — a loading, failed, or empty
    // catalog must not strand unrelated Repository settings.
    for (const catalog of [
      { catalogLoading: true, catalogModels: undefined },
      { catalogLoading: false, catalogFailed: true, catalogModels: undefined },
      { catalogLoading: false, catalogModels: [] },
    ]) {
      expect(
        blocksAgentModelSave({
          ...catalog,
          modelId: "",
          requireSelection: false,
        }),
      ).toBe(false)
    }
  })

  test("a stale explicit value blocks Save until a current model is chosen", () => {
    const stale = {
      ...ready(claudeCatalog),
      modelId: systemProfileId,
      requireSelection: false,
    }
    expect(blocksAgentModelSave(stale)).toBe(true)
    expect(
      agentModelSaveBlockReason({ ...stale, ...firstPartyClaudeScope }),
    ).toMatch(/not in the current Agent Model catalog/)
    // Picking a current model unblocks; so does clearing back to inheritance.
    expect(blocksAgentModelSave({ ...stale, modelId: "sonnet" })).toBe(false)
    expect(blocksAgentModelSave({ ...stale, modelId: "" })).toBe(false)
  })

  test("a healthy catalog reports no block reason", () => {
    expect(
      agentModelSaveBlockReason({
        ...ready(bedrockCatalog),
        ...bedrockScope,
        modelId: applicationArn,
        requireSelection: true,
      }),
    ).toBeNull()
    expect(
      agentModelCatalogNotice({ ...ready(claudeCatalog), ...opencodeScope }),
    ).toBeNull()
  })

  test("catalog notice explains an unusable catalog while inheriting", () => {
    expect(
      agentModelCatalogNotice({
        catalogLoading: false,
        catalogModels: [],
        ...opencodeScope,
      }),
    ).toMatch(/No Agent Models are available/)
  })
})

describe("Thinking Levels derive from the selected catalog entry (issue #838)", () => {
  test("levels come from the catalog entry, for every backend", () => {
    expect(thinkingLevelsForModel(claudeCatalog, "sonnet")).toEqual([
      ...CLAUDE_EFFORT,
    ])
    expect(
      thinkingLevelsForModel(
        opencodeCatalog,
        "opencode/deepseek-v4-flash-free",
      ),
    ).toEqual(["high", "max"])
    expect(thinkingLevelsForModel(bedrockCatalog, applicationArn)).toEqual([
      ...CLAUDE_EFFORT,
    ])
  })

  test("no invented levels for unknown models or unloaded catalogs", () => {
    // The first-party Claude free-text fallback is gone (#806 superseded):
    // an unknown model has no effort options rather than the full alias set.
    expect(thinkingLevelsForModel(claudeCatalog, systemProfileId)).toEqual([])
    expect(thinkingLevelsForModel(undefined, "sonnet")).toEqual([])
    expect(thinkingLevelsForModel([], "sonnet")).toEqual([])
    expect(thinkingLevelsForModel(claudeCatalog, "")).toEqual([])
    expect(thinkingLevelsForModel(opencodeCatalog, "opencode/gpt-5")).toEqual(
      [],
    )
  })

  test("an incompatible stored level is cleared on model change", () => {
    expect(reconcileVariantForModel("high", ["high", "max"])).toBe("high")
    expect(reconcileVariantForModel("low", ["high", "max"])).toBe("")
    expect(reconcileVariantForModel("", ["high", "max"])).toBe("")
  })

  test("a preserved incompatible level is labelled unavailable", () => {
    expect(formatUnavailableVariantLabel("xhigh")).toBe(
      "Xhigh (not available for this model)",
    )
  })

  test("review options follow runtime fallback order", () => {
    expect(
      governingReviewModelId({
        reviewModel: "repo-review",
        harnessReviewModel: "harness-review",
        resolvedBuildModel: "repo-build",
      }),
    ).toBe("repo-review")
    expect(
      governingReviewModelId({
        reviewModel: "",
        harnessReviewModel: "harness-review",
        resolvedBuildModel: "repo-build",
      }),
    ).toBe("harness-review")
    expect(
      governingReviewModelId({
        reviewModel: "",
        harnessReviewModel: "",
        resolvedBuildModel: "repo-build",
      }),
    ).toBe("repo-build")
  })

  test("an applicable incompatible Thinking Level blocks Save", () => {
    const stale = {
      ...ready(opencodeCatalog),
      applicable: true,
      thinkingLevel: "medium",
      governingModelId: "opencode/deepseek-v4-flash-free",
    }
    expect(blocksThinkingLevelSave(stale)).toBe(true)
    expect(thinkingLevelSaveBlockReason(stale)).toMatch(
      /not advertised by the governing Agent Model/,
    )
    expect(blocksThinkingLevelSave({ ...stale, thinkingLevel: "high" })).toBe(
      false,
    )
    expect(
      thinkingLevelSaveBlockReason({ ...stale, thinkingLevel: "high" }),
    ).toBeNull()
    expect(blocksThinkingLevelSave({ ...stale, thinkingLevel: "" })).toBe(false)
    expect(blocksThinkingLevelSave({ ...stale, applicable: false })).toBe(false)
    expect(
      blocksThinkingLevelSave({
        ...ready(opencodeCatalog),
        applicable: true,
        thinkingLevel: "high",
        governingModelId: "opencode/gpt-5",
      }),
    ).toBe(true)
    expect(
      blocksThinkingLevelSave({
        ...ready(opencodeCatalog),
        applicable: true,
        thinkingLevel: "",
        governingModelId: "opencode/gpt-5",
      }),
    ).toBe(false)
  })

  test("empty Thinking Level labels match runtime fallback semantics", () => {
    expect(
      emptyThinkingLevelOptionLabel({
        explicitModel: true,
        fallsBackToBuild: false,
      }),
    ).toBe("Model default")
    expect(
      emptyThinkingLevelOptionLabel({
        explicitModel: false,
        inheritedLabel: "high",
        fallsBackToBuild: false,
      }),
    ).toBe("Harness default (high)")
    expect(
      emptyThinkingLevelOptionLabel({
        explicitModel: false,
        fallsBackToBuild: true,
      }),
    ).toBe("Same as build effort (thinking)")
    expect(
      emptyThinkingLevelOptionLabel({
        explicitModel: false,
        inheritedLabel: "max",
        fallsBackToBuild: true,
      }),
    ).toBe("Harness default (max)")
  })
})

describe("Agent Model presentation (issue #821)", () => {
  const systemModel = bedrockCatalog[0]
  const applicationModel = bedrockCatalog[1]

  test("formatAgentModelLabel keeps executable id while showing name and kind", () => {
    expect(formatAgentModelKindLabel(AGENT_MODEL_KIND_SYSTEM_DEFINED)).toBe(
      "System",
    )
    expect(formatAgentModelKindLabel(AGENT_MODEL_KIND_APPLICATION)).toBe(
      "Application",
    )
    expect(formatAgentModelLabel(systemModel)).toBe(
      "US Anthropic Claude Sonnet 4.6 · System · us.anthropic.claude-sonnet-4-6",
    )
    expect(formatAgentModelLabel(applicationModel)).toBe(
      `My Org Sonnet · Application · ${applicationArn}`,
    )
    // Plain aliases stay unchanged when no presentation metadata is present.
    expect(
      formatAgentModelLabel({
        id: "sonnet",
        thinkingLevels: [...CLAUDE_EFFORT],
      }),
    ).toBe("sonnet")
  })

  test("findCatalogModel matches by executable id only", () => {
    const catalog = [systemModel, applicationModel]
    expect(findCatalogModel(catalog, systemModel.id)).toEqual(systemModel)
    expect(findCatalogModel(catalog, applicationArn)).toEqual(applicationModel)
    expect(findCatalogModel(catalog, "sonnet")).toBeUndefined()
    // Friendly name is presentation-only — never a lookup key.
    expect(
      findCatalogModel(catalog, "US Anthropic Claude Sonnet 4.6"),
    ).toBeUndefined()
    expect(findCatalogModel(undefined, systemModel.id)).toBeUndefined()
  })
})

describe("Claude Bedrock configuration mode (issue #828)", () => {
  test("mode selects operator guidance wording only", () => {
    expect(
      isClaudeBedrockConfigurationMode(
        CLAUDE_AGENT_BACKEND_ID,
        CLAUDE_BEDROCK_CONFIGURATION_MODE,
      ),
    ).toBe(true)
    expect(
      isClaudeBedrockConfigurationMode(CLAUDE_AGENT_BACKEND_ID, null),
    ).toBe(false)
    expect(
      isClaudeBedrockConfigurationMode(
        "opencode",
        CLAUDE_BEDROCK_CONFIGURATION_MODE,
      ),
    ).toBe(false)
    // Enforcement itself is identical regardless of mode.
    const stale = {
      ...ready(bedrockCatalog),
      modelId: "sonnet",
      requireSelection: true,
    }
    expect(blocksAgentModelSave(stale)).toBe(true)
    expect(agentModelSaveBlockReason({ ...stale, ...bedrockScope })).toMatch(
      /not in the current Bedrock profile catalog/,
    )
  })
})
