import { CLAUDE_THINKING_LEVELS } from "@ready-for-agent/claude"
import {
  CLAUDE_AGENT_BACKEND_ID,
  CLAUDE_FREE_TEXT_THINKING_LEVELS,
  allowsClaudeFreeTextModels,
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

describe("Claude free-text Agent Model settings (issue #806)", () => {
  test("only Claude backend allows free-text model strings", () => {
    expect(allowsClaudeFreeTextModels(CLAUDE_AGENT_BACKEND_ID)).toBe(true)
    expect(allowsClaudeFreeTextModels("opencode")).toBe(false)
    expect(allowsClaudeFreeTextModels("codex")).toBe(false)
    expect(allowsClaudeFreeTextModels("grok")).toBe(false)
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

  test("other backends do not invent effort levels for unknown models", () => {
    expect(
      thinkingLevelsForModel("opencode", claudeCatalog, "custom-id"),
    ).toEqual([])
    expect(thinkingLevelsForModel("opencode", undefined, "custom-id")).toEqual(
      [],
    )
  })

  test("catalog membership is not required for Claude free-text at Save", () => {
    const freeText = "us.anthropic.claude-sonnet-4-6"
    expect(
      isUnavailableCatalogModel({
        backendId: "claude",
        modelId: freeText,
        catalogModelIds: catalogIds,
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

describe("Harness Settings Claude free-text surface (source contract)", () => {
  test("harness and repository settings allow free-text Claude model fields", async () => {
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
    expect(root).toContain("Claude free-text custom ids are allowed")
    // Save must not block Claude free-text solely for catalog absence.
    expect(root).toContain("hasUnavailableBuildModel")
    expect(root).toContain("isUnavailableCatalogModel")

    expect(index).toContain("allowsClaudeFreeTextModels")
    expect(index).toContain("repo-claude-build-models-")
    expect(index).toContain("blockSaveForUnavailableBuildModel")
    expect(index).toContain("isUnavailableCatalogModel")
  })
})
