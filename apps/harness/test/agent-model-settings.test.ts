import { CLAUDE_THINKING_LEVELS } from "@ready-for-agent/claude"
import {
  AGENT_MODEL_KIND_APPLICATION,
  AGENT_MODEL_KIND_SYSTEM_DEFINED,
  CLAUDE_AGENT_BACKEND_ID,
  CLAUDE_BEDROCK_CONFIGURATION_MODE,
  CLAUDE_FREE_TEXT_THINKING_LEVELS,
  allowsClaudeFreeTextModels,
  blocksClaudeBedrockModelSave,
  claudeBedrockModelSaveBlockReason,
  findCatalogModel,
  formatAgentModelKindLabel,
  formatAgentModelLabel,
  isClaudeBedrockConfigurationMode,
  isCustomAgentModelValue,
  isUnavailableCatalogModel,
  thinkingLevelsForModel,
} from "../src/agent-model-settings.js"
import { describe, expect, test } from "bun:test"

const claudeCatalog = [
  { id: "haiku", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "sonnet", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "opus", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "fable", thinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
] as const

const catalogIds = claudeCatalog.map((model) => model.id)

const systemProfileId = "us.anthropic.claude-sonnet-4-6"
const applicationArn =
  "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/my-org-sonnet"

const bedrockCatalog = [
  {
    id: systemProfileId,
    thinkingLevels: [...CLAUDE_FREE_TEXT_THINKING_LEVELS],
    name: "US Anthropic Claude Sonnet 4.6",
    kind: AGENT_MODEL_KIND_SYSTEM_DEFINED,
  },
  {
    id: applicationArn,
    thinkingLevels: [...CLAUDE_FREE_TEXT_THINKING_LEVELS],
    name: "My Org Sonnet",
    kind: AGENT_MODEL_KIND_APPLICATION,
  },
] as const

describe("Claude free-text Agent Model settings (issue #806)", () => {
  test("only first-party Claude backend allows free-text model strings", () => {
    expect(allowsClaudeFreeTextModels(CLAUDE_AGENT_BACKEND_ID)).toBe(true)
    expect(allowsClaudeFreeTextModels(CLAUDE_AGENT_BACKEND_ID, null)).toBe(true)
    expect(allowsClaudeFreeTextModels("opencode")).toBe(false)
    expect(allowsClaudeFreeTextModels("codex")).toBe(false)
    expect(allowsClaudeFreeTextModels("grok")).toBe(false)
  })

  test("Claude Code Bedrock mode disables free-text (issue #828)", () => {
    expect(
      allowsClaudeFreeTextModels(
        CLAUDE_AGENT_BACKEND_ID,
        CLAUDE_BEDROCK_CONFIGURATION_MODE,
      ),
    ).toBe(false)
    expect(
      isClaudeBedrockConfigurationMode(
        CLAUDE_AGENT_BACKEND_ID,
        CLAUDE_BEDROCK_CONFIGURATION_MODE,
      ),
    ).toBe(true)
    expect(isClaudeBedrockConfigurationMode("claude", null)).toBe(false)
    expect(
      isClaudeBedrockConfigurationMode(
        "opencode",
        CLAUDE_BEDROCK_CONFIGURATION_MODE,
      ),
    ).toBe(false)
  })

  test("local free-text effort set stays aligned with Claude package catalog", () => {
    // Client helpers keep a local literal to avoid importing the adapter barrel.
    expect([...CLAUDE_FREE_TEXT_THINKING_LEVELS]).toEqual([
      ...CLAUDE_THINKING_LEVELS,
    ])
  })

  test("catalog aliases still resolve thinking levels from the catalog", () => {
    expect(thinkingLevelsForModel("claude", claudeCatalog, "sonnet")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  test("Claude free-text models offer the full Claude effort catalog", () => {
    const freeText =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile"
    expect(thinkingLevelsForModel("claude", claudeCatalog, freeText)).toEqual([
      ...CLAUDE_FREE_TEXT_THINKING_LEVELS,
    ])
    expect(CLAUDE_FREE_TEXT_THINKING_LEVELS).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  test("Claude free-text effort does not require a loaded catalog (issue #806 review)", () => {
    const freeText =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile"
    // models query pending / Settings just opened
    expect(thinkingLevelsForModel("claude", undefined, freeText)).toEqual([
      ...CLAUDE_FREE_TEXT_THINKING_LEVELS,
    ])
    // failed/empty preview still offers static Claude effort
    expect(thinkingLevelsForModel("claude", [], freeText)).toEqual([
      ...CLAUDE_FREE_TEXT_THINKING_LEVELS,
    ])
    // Claude aliases while catalog is pending also get the static set
    expect(thinkingLevelsForModel("claude", undefined, "sonnet")).toEqual([
      ...CLAUDE_FREE_TEXT_THINKING_LEVELS,
    ])
  })

  test("Bedrock mode does not invent free-text effort for non-catalog values", () => {
    expect(
      thinkingLevelsForModel(
        "claude",
        bedrockCatalog,
        "operator-typed-custom",
        CLAUDE_BEDROCK_CONFIGURATION_MODE,
      ),
    ).toEqual([])
    expect(
      thinkingLevelsForModel(
        "claude",
        undefined,
        systemProfileId,
        CLAUDE_BEDROCK_CONFIGURATION_MODE,
      ),
    ).toEqual([])
  })

  test("other backends do not invent effort levels for unknown models", () => {
    expect(
      thinkingLevelsForModel("opencode", claudeCatalog, "custom-id"),
    ).toEqual([])
    expect(thinkingLevelsForModel("opencode", undefined, "custom-id")).toEqual(
      [],
    )
  })

  test("catalog membership is not required for first-party Claude free-text at Save", () => {
    const freeText = "us.anthropic.claude-sonnet-4-6"
    expect(
      isUnavailableCatalogModel({
        backendId: "claude",
        modelId: freeText,
        catalogModelIds: catalogIds,
      }),
    ).toBe(false)
  })

  test("catalog membership is required for Claude Bedrock mode at Save", () => {
    expect(
      isUnavailableCatalogModel({
        backendId: "claude",
        modelId: "operator-typed-custom",
        catalogModelIds: bedrockCatalog.map((model) => model.id),
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
      }),
    ).toBe(true)
    expect(
      isUnavailableCatalogModel({
        backendId: "claude",
        modelId: systemProfileId,
        catalogModelIds: bedrockCatalog.map((model) => model.id),
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
      }),
    ).toBe(false)
  })

  test("catalog-absent models still block Save for non-Claude backends", () => {
    expect(
      isUnavailableCatalogModel({
        backendId: "opencode",
        modelId: "missing-model",
        catalogModelIds: ["opencode/deepseek-v4-flash-free"],
      }),
    ).toBe(true)
  })

  test("empty model is never treated as unavailable", () => {
    expect(
      isUnavailableCatalogModel({
        backendId: "claude",
        modelId: "",
        catalogModelIds: catalogIds,
      }),
    ).toBe(false)
  })
})

describe("Claude Bedrock strict Save gates (issue #828)", () => {
  test("blocks Save while catalog is loading or unknown", () => {
    expect(
      blocksClaudeBedrockModelSave({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: true,
        catalogModels: undefined,
        modelId: "",
        requireSelection: true,
      }),
    ).toBe(true)
    expect(
      claudeBedrockModelSaveBlockReason({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: true,
        catalogModels: undefined,
        modelId: "",
        requireSelection: true,
      }),
    ).toMatch(/Loading Bedrock/)
  })

  test("blocks Save with a distinct reason when catalog load failed", () => {
    expect(
      blocksClaudeBedrockModelSave({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogFailed: true,
        catalogModels: undefined,
        modelId: systemProfileId,
        requireSelection: true,
      }),
    ).toBe(true)
    expect(
      claudeBedrockModelSaveBlockReason({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogFailed: true,
        catalogModels: undefined,
        modelId: systemProfileId,
        requireSelection: true,
      }),
    ).toMatch(/Could not load the Bedrock profile catalog/)
  })

  test("blocks Save when discovery returns no profiles", () => {
    expect(
      blocksClaudeBedrockModelSave({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogModels: [],
        modelId: "",
        requireSelection: true,
      }),
    ).toBe(true)
    expect(
      claudeBedrockModelSaveBlockReason({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogModels: [],
        modelId: "",
        requireSelection: true,
        discoveryWarnings: [
          "Could not list Amazon Bedrock inference profiles: access denied.",
        ],
      }),
    ).toMatch(/access denied/)
  })

  test("blocks Save with no selection when selection is required", () => {
    expect(
      blocksClaudeBedrockModelSave({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogModels: bedrockCatalog,
        modelId: "",
        requireSelection: true,
      }),
    ).toBe(true)
    expect(
      blocksClaudeBedrockModelSave({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogModels: bedrockCatalog,
        modelId: "",
        requireSelection: false,
      }),
    ).toBe(false)
  })

  test("blocks Save when saved value is absent from the current catalog", () => {
    expect(
      blocksClaudeBedrockModelSave({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogModels: bedrockCatalog,
        modelId: "stale-out-of-region-profile",
        requireSelection: true,
      }),
    ).toBe(true)
    expect(
      claudeBedrockModelSaveBlockReason({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogModels: bedrockCatalog,
        modelId: "stale-out-of-region-profile",
        requireSelection: true,
      }),
    ).toMatch(/not in the current Bedrock profile catalog/)
  })

  test("allows Save for system-defined ID and application ARN selections", () => {
    expect(
      blocksClaudeBedrockModelSave({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogModels: bedrockCatalog,
        modelId: systemProfileId,
        requireSelection: true,
      }),
    ).toBe(false)
    expect(
      blocksClaudeBedrockModelSave({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogModels: bedrockCatalog,
        modelId: applicationArn,
        requireSelection: true,
      }),
    ).toBe(false)
    expect(
      claudeBedrockModelSaveBlockReason({
        backendId: "claude",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: false,
        catalogModels: bedrockCatalog,
        modelId: systemProfileId,
        requireSelection: true,
      }),
    ).toBeNull()
  })

  test("does not apply Bedrock Save gates to first-party Claude or other backends", () => {
    expect(
      blocksClaudeBedrockModelSave({
        backendId: "claude",
        configurationMode: null,
        catalogLoading: true,
        catalogModels: undefined,
        modelId: "",
        requireSelection: true,
      }),
    ).toBe(false)
    expect(
      blocksClaudeBedrockModelSave({
        backendId: "opencode",
        configurationMode: CLAUDE_BEDROCK_CONFIGURATION_MODE,
        catalogLoading: true,
        catalogModels: undefined,
        modelId: "",
        requireSelection: true,
      }),
    ).toBe(false)
  })
})

describe("Bedrock Agent Model presentation (issue #821)", () => {
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
        thinkingLevels: [...CLAUDE_FREE_TEXT_THINKING_LEVELS],
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
  })

  test("isCustomAgentModelValue waits for a loaded catalog (issue #821 review)", () => {
    const catalog = [systemModel, applicationModel]
    // Pending/undefined catalog must not flash "custom" for saved values.
    expect(
      isCustomAgentModelValue({
        models: undefined,
        modelId: systemModel.id,
      }),
    ).toBe(false)
    expect(
      isCustomAgentModelValue({
        models: undefined,
        modelId: "operator-typed-custom",
      }),
    ).toBe(false)
    // Loaded empty catalog: any non-empty value is custom.
    expect(
      isCustomAgentModelValue({
        models: [],
        modelId: systemModel.id,
      }),
    ).toBe(true)
    // Loaded catalog: match is not custom; absent value is.
    expect(
      isCustomAgentModelValue({
        models: catalog,
        modelId: systemModel.id,
      }),
    ).toBe(false)
    expect(
      isCustomAgentModelValue({
        models: catalog,
        modelId: applicationArn,
      }),
    ).toBe(false)
    expect(
      isCustomAgentModelValue({
        models: catalog,
        modelId: "operator-typed-custom",
      }),
    ).toBe(true)
    expect(
      isCustomAgentModelValue({
        models: catalog,
        modelId: "",
      }),
    ).toBe(false)
  })

  test("discovered Bedrock profiles keep Claude thinking levels", () => {
    expect(
      thinkingLevelsForModel(
        "claude",
        [systemModel, applicationModel],
        systemModel.id,
      ),
    ).toEqual([...CLAUDE_FREE_TEXT_THINKING_LEVELS])
    expect(
      thinkingLevelsForModel(
        "claude",
        [systemModel, applicationModel],
        applicationArn,
      ),
    ).toEqual([...CLAUDE_FREE_TEXT_THINKING_LEVELS])
  })
})

describe("Harness Settings Claude free-text / Bedrock surface (source contract)", () => {
  test("first-party Claude free-text surface remains in harness and repository settings", async () => {
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const root = readFileSync(
      join(import.meta.dir, "../src/routes/__root.tsx"),
      "utf8",
    )
    const index = readFileSync(
      join(import.meta.dir, "../src/routes/index.tsx"),
      "utf8",
    )
    expect(root).toContain("allowsClaudeFreeTextModels")
    expect(root).toContain("harness-claude-build-models")
    expect(root).toContain("Alias or custom model ID")
    expect(root).toContain("First-party Claude free-text")
    expect(root).toContain("hasUnavailableBuildModel")
    expect(root).toContain("isUnavailableCatalogModel")
    // Issue #828: Bedrock mode uses configurationMode metadata + strict select.
    expect(root).toContain("configurationMode: true")
    expect(root).toContain("claudeBedrockStrict")
    expect(root).toContain("blocksClaudeBedrockModelSave")
    expect(root).toContain("Select a Bedrock inference profile")
    expect(root).toContain("blockSaveForBedrockBuildModel")
    // Submit and disabled button share one gate so Enter cannot bypass Save.
    expect(root).toContain("harnessSettingsSaveBlocked")
    expect(root).toContain("if (harnessSettingsSaveBlocked)")

    expect(index).toContain("allowsClaudeFreeTextModels")
    expect(index).toContain("repo-claude-build-models-")
    expect(index).toContain("blockSaveForUnavailableBuildModel")
    expect(index).toContain("isUnavailableCatalogModel")
    expect(index).toContain("configurationMode: true")
    expect(index).toContain("claudeBedrockStrict")
    expect(index).toContain("blocksClaudeBedrockModelSave")
    expect(index).toContain("repositorySettingsSaveBlocked")
    expect(index).toContain("if (repositorySettingsSaveBlocked)")
  })
})
