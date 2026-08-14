import {
  resolveAgentModelSelection,
  resolvedSelectionCatalogViolation,
} from "../src/lib/resolve-agent-models.js"
import { describe, expect, it } from "bun:test"

describe("resolveAgentModelSelection", () => {
  const harness = {
    defaultModel: "anthropic/claude-sonnet-4-5",
    defaultThinkingLevel: "high",
    reviewModel: null as string | null,
    reviewThinkingLevel: null as string | null,
  }

  it("returns null when no build model can be resolved", () => {
    expect(
      resolveAgentModelSelection(null, {
        defaultModel: null,
        defaultThinkingLevel: "low",
        reviewModel: null,
        reviewThinkingLevel: null,
      }),
    ).toBeNull()
  })

  it("allows repository build override when harness defaults are unset", () => {
    expect(
      resolveAgentModelSelection(
        {
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultThinkingLevel: "max",
          reviewModel: null,
          reviewThinkingLevel: null,
        },
        {
          defaultModel: null,
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
        },
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "max",
      reviewModel: "anthropic/claude-sonnet-4-5",
      reviewThinkingLevel: "max",
    })
  })

  it("does not inherit thinking level when an explicit model has none", () => {
    expect(
      resolveAgentModelSelection(
        {
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
        },
        {
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
        },
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: null,
      reviewModel: "anthropic/claude-sonnet-4-5",
      reviewThinkingLevel: null,
    })
  })

  it("inherits the complete harness selection when repository model is absent", () => {
    expect(
      resolveAgentModelSelection(
        {
          defaultModel: null,
          defaultThinkingLevel: "max",
          reviewModel: null,
          reviewThinkingLevel: null,
        },
        harness,
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
      reviewModel: "anthropic/claude-sonnet-4-5",
      reviewThinkingLevel: "high",
    })
  })

  it("prefers repository model and thinking level overrides when set", () => {
    expect(
      resolveAgentModelSelection(
        {
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultThinkingLevel: "max",
          reviewModel: "anthropic/claude-opus-4-6",
          reviewThinkingLevel: "high",
        },
        {
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
        },
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "max",
      reviewModel: "anthropic/claude-opus-4-6",
      reviewThinkingLevel: "high",
    })
  })

  it("passes Claude free-text / Bedrock model ids through as opaque preference strings (issue #806)", () => {
    const freeText =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile"
    expect(
      resolveAgentModelSelection(
        {
          defaultModel: freeText,
          defaultThinkingLevel: "high",
          reviewModel: "us.anthropic.claude-opus-4-6",
          reviewThinkingLevel: "max",
        },
        harness,
      ),
    ).toEqual({
      model: freeText,
      thinkingLevel: "high",
      reviewModel: "us.anthropic.claude-opus-4-6",
      reviewThinkingLevel: "max",
    })
  })

  it("falls back review model to build model when unset", () => {
    expect(resolveAgentModelSelection(null, harness)).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
      reviewModel: "anthropic/claude-sonnet-4-5",
      reviewThinkingLevel: "high",
    })
  })

  it("keeps a configured review thinking level when review model falls back to build", () => {
    expect(
      resolveAgentModelSelection(
        {
          defaultModel: null,
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: "max",
        },
        {
          defaultModel: "anthropic/claude-sonnet-4-5",
          defaultThinkingLevel: "high",
          reviewModel: null,
          reviewThinkingLevel: "medium",
        },
      ),
    ).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
      reviewModel: "anthropic/claude-sonnet-4-5",
      reviewThinkingLevel: "max",
    })
  })

  it("uses harness review selection when repository review is unset", () => {
    expect(
      resolveAgentModelSelection(null, {
        defaultModel: "anthropic/claude-sonnet-4-5",
        defaultThinkingLevel: "high",
        reviewModel: "anthropic/claude-opus-4-6",
        reviewThinkingLevel: "max",
      }),
    ).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: "high",
      reviewModel: "anthropic/claude-opus-4-6",
      reviewThinkingLevel: "max",
    })
  })
})

describe("resolvedSelectionCatalogViolation", () => {
  const catalog = [
    { id: "opencode/deepseek-v4-flash-free", thinkingLevels: ["high"] },
    { id: "opencode/gpt-5", thinkingLevels: [] },
  ]

  it("returns null for an empty catalog", () => {
    expect(
      resolvedSelectionCatalogViolation({
        backendLabel: "OpenCode",
        catalog: [],
        selection: {
          model: "missing",
          thinkingLevel: "medium",
          reviewModel: "missing",
          reviewThinkingLevel: "medium",
        },
        includeReviewModel: true,
      }),
    ).toBeNull()
  })

  it("reports a missing model before a Thinking Level mismatch", () => {
    const violation = resolvedSelectionCatalogViolation({
      backendLabel: "OpenCode",
      catalog,
      selection: {
        model: "missing",
        thinkingLevel: "medium",
        reviewModel: "opencode/gpt-5",
        reviewThinkingLevel: null,
      },
      includeReviewModel: true,
    })
    expect(violation?.kind).toBe("model")
    expect(violation?.message).toContain("missing")
    expect(violation?.message).toContain("Agent Model catalog")
  })

  it("reports an unsupported Thinking Level with a distinct kind", () => {
    const violation = resolvedSelectionCatalogViolation({
      backendLabel: "OpenCode",
      catalog,
      selection: {
        model: "opencode/deepseek-v4-flash-free",
        thinkingLevel: "medium",
        reviewModel: "opencode/gpt-5",
        reviewThinkingLevel: null,
      },
      includeReviewModel: true,
    })
    expect(violation?.kind).toBe("thinking_level")
    expect(violation?.message).toContain("medium")
    expect(violation?.message).toContain("opencode/deepseek-v4-flash-free")
  })

  it("rejects a non-null level when the catalog entry advertises none", () => {
    const violation = resolvedSelectionCatalogViolation({
      backendLabel: "OpenCode",
      catalog,
      selection: {
        model: "opencode/gpt-5",
        thinkingLevel: "low",
        reviewModel: "opencode/gpt-5",
        reviewThinkingLevel: null,
      },
      includeReviewModel: false,
    })
    expect(violation?.kind).toBe("thinking_level")
    expect(violation?.message).toContain("offers no Thinking Levels")
  })

  it("accepts an advertised level and a null level", () => {
    expect(
      resolvedSelectionCatalogViolation({
        backendLabel: "OpenCode",
        catalog,
        selection: {
          model: "opencode/deepseek-v4-flash-free",
          thinkingLevel: "high",
          reviewModel: "opencode/gpt-5",
          reviewThinkingLevel: null,
        },
        includeReviewModel: true,
      }),
    ).toBeNull()
  })
})
