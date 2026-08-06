import {
  formatAgentBackendStatusLabel,
  formatAgentBackendStatusTrail,
} from "../src/agent-backend-status-label.js"
import { describe, expect, test } from "bun:test"

describe("formatAgentBackendStatusLabel (issue #819)", () => {
  test("shows Claude Code · Amazon Bedrock · Ready", () => {
    expect(
      formatAgentBackendStatusLabel({
        backendLabel: "Claude Code",
        kind: "READY",
        provider: { id: "bedrock", label: "Amazon Bedrock" },
      }),
    ).toBe("Claude Code · Amazon Bedrock · Ready")
  })

  test("shows first-party distinctly from Bedrock", () => {
    expect(
      formatAgentBackendStatusLabel({
        backendLabel: "Claude Code",
        kind: "READY",
        provider: { id: "firstParty", label: "First-party" },
      }),
    ).toBe("Claude Code · First-party · Ready")
  })

  test("omits provider segment when the backend does not report one", () => {
    expect(
      formatAgentBackendStatusLabel({
        backendLabel: "OpenCode",
        kind: "READY",
        provider: null,
      }),
    ).toBe("OpenCode · Ready")
  })

  test("includes Default and Unavailable reason in the trail", () => {
    expect(
      formatAgentBackendStatusLabel({
        backendLabel: "Claude Code",
        kind: "UNAVAILABLE",
        provider: { id: "bedrock", label: "Amazon Bedrock" },
        isDefault: true,
        reason:
          "Claude Code Amazon Bedrock is not ready. Ensure valid AWS credentials",
      }),
    ).toBe(
      "Claude Code · Amazon Bedrock · Default · Unavailable — Claude Code Amazon Bedrock is not ready. Ensure valid AWS credentials",
    )
  })

  test("trail form keeps the leading middle-dot for strong backend labels", () => {
    expect(
      formatAgentBackendStatusTrail({
        kind: "READY",
        provider: { id: "bedrock", label: "Amazon Bedrock" },
      }),
    ).toBe(" · Amazon Bedrock · Ready")
  })
})
