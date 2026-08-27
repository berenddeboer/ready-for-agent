import { selectJumpAgentModel } from "../src/lib/jump-agent-model.js"
import { describe, expect, test } from "bun:test"

const selection = {
  model: "amazon-bedrock/au.anthropic.claude-sonnet-5",
  thinkingLevel: "high",
  reviewModel: "anthropic/claude-opus-4-6",
  reviewThinkingLevel: "xhigh",
} as const

describe("selectJumpAgentModel", () => {
  test("pins the build Agent Model while a Build Step Run is running", () => {
    expect(
      selectJumpAgentModel({
        runningStep: "implement",
        workItemState: "implement",
        selection,
      }),
    ).toEqual({
      model: "amazon-bedrock/au.anthropic.claude-sonnet-5",
      thinkingLevel: "high",
    })
  })

  test("pins the review Agent Model while a Review Step Run is running", () => {
    expect(
      selectJumpAgentModel({
        runningStep: "review",
        workItemState: "review",
        selection,
      }),
    ).toEqual({
      model: "anthropic/claude-opus-4-6",
      thinkingLevel: "xhigh",
    })
  })

  test("pins the build Agent Model while Review is applying findings", () => {
    expect(
      selectJumpAgentModel({
        runningStep: "review",
        runningStepReason: "review_applying_findings",
        workItemState: "review",
        selection,
      }),
    ).toEqual({
      model: "amazon-bedrock/au.anthropic.claude-sonnet-5",
      thinkingLevel: "high",
    })
  })

  test("pins the review Agent Model when the Work Item is in Review with no running Step Run", () => {
    expect(
      selectJumpAgentModel({
        runningStep: null,
        workItemState: "review",
        selection,
      }),
    ).toEqual({
      model: "anthropic/claude-opus-4-6",
      thinkingLevel: "xhigh",
    })
  })

  test("pins the build Agent Model for later PR steps", () => {
    expect(
      selectJumpAgentModel({
        runningStep: "create_pr",
        workItemState: "create_pr",
        selection,
      }),
    ).toEqual({
      model: "amazon-bedrock/au.anthropic.claude-sonnet-5",
      thinkingLevel: "high",
    })
  })

  test("returns null when no Agent Model can be resolved", () => {
    expect(
      selectJumpAgentModel({
        runningStep: "implement",
        workItemState: "implement",
        selection: null,
      }),
    ).toBeNull()
  })
})
