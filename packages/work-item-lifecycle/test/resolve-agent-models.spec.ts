import { resolveAgentModelSelection } from "../src/lib/resolve-agent-models.js"
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
