import {
  AGENT_BACKEND_IDS,
  CLAUDE_CODE_BEDROCK_CONFIGURATION_MODE,
  CLAUDE_CODE_BEDROCK_LABEL,
  CLAUDE_CODE_LABEL,
  agentBackendLabel,
  capabilitySupported,
  defaultAgentBackendId,
  getBuiltInAgentBackend,
  isAgentDependentLifecycleStep,
  isAgentFreeLifecycleStep,
  isClaudeCodeBedrockConfigurationMode,
  listBuiltInAgentBackends,
  listSelectableAgentBackendInfos,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("Agent Backend registry", () => {
  it("exposes OpenCode, Grok Build, Codex Build, and Claude Code as selectable production backends", () => {
    const backends = listBuiltInAgentBackends()
    expect(backends.map((entry) => entry.descriptor.id)).toEqual([
      AGENT_BACKEND_IDS.opencode,
      AGENT_BACKEND_IDS.grok,
      AGENT_BACKEND_IDS.codex,
      AGENT_BACKEND_IDS.claude,
    ])
    expect(defaultAgentBackendId).toBe(AGENT_BACKEND_IDS.opencode)
    expect(getBuiltInAgentBackend("missing")).toBeUndefined()
    expect(
      getBuiltInAgentBackend(AGENT_BACKEND_IDS.grok)?.descriptor.label,
    ).toBe("Grok Build")
    expect(
      getBuiltInAgentBackend(AGENT_BACKEND_IDS.codex)?.descriptor.label,
    ).toBe("Codex Build")
    expect(
      getBuiltInAgentBackend(AGENT_BACKEND_IDS.claude)?.descriptor.label,
    ).toBe("Claude Code")
  })

  it("maps backend ids to operator-visible labels for failure copy", () => {
    expect(agentBackendLabel(AGENT_BACKEND_IDS.opencode)).toBe("OpenCode")
    expect(agentBackendLabel(AGENT_BACKEND_IDS.grok)).toBe("Grok Build")
    expect(agentBackendLabel(AGENT_BACKEND_IDS.codex)).toBe("Codex Build")
    expect(agentBackendLabel(AGENT_BACKEND_IDS.claude)).toBe(CLAUDE_CODE_LABEL)
    expect(agentBackendLabel("unknown-backend")).toBe("unknown-backend")
  })

  it("selects Claude Code Bedrock configuration mode only for CLAUDE_CODE_USE_BEDROCK=1", () => {
    // Issue #828: exact value "1" only; browser never reads process env.
    expect(isClaudeCodeBedrockConfigurationMode({})).toBe(false)
    expect(
      isClaudeCodeBedrockConfigurationMode({ CLAUDE_CODE_USE_BEDROCK: "0" }),
    ).toBe(false)
    expect(
      isClaudeCodeBedrockConfigurationMode({ CLAUDE_CODE_USE_BEDROCK: "true" }),
    ).toBe(false)
    expect(
      isClaudeCodeBedrockConfigurationMode({ CLAUDE_CODE_USE_BEDROCK: "1" }),
    ).toBe(true)
  })

  it("lists Claude Code Bedrock label and mode when Bedrock configuration is enabled", () => {
    const firstParty = listSelectableAgentBackendInfos({})
    const claudeFirstParty = firstParty.find(
      (entry) => entry.id === AGENT_BACKEND_IDS.claude,
    )
    expect(claudeFirstParty).toEqual({
      id: AGENT_BACKEND_IDS.claude,
      label: CLAUDE_CODE_LABEL,
      configurationMode: null,
    })
    expect(
      firstParty.find((entry) => entry.id === AGENT_BACKEND_IDS.opencode),
    ).toEqual({
      id: AGENT_BACKEND_IDS.opencode,
      label: "OpenCode",
      configurationMode: null,
    })

    const bedrock = listSelectableAgentBackendInfos({
      CLAUDE_CODE_USE_BEDROCK: "1",
    })
    expect(
      bedrock.find((entry) => entry.id === AGENT_BACKEND_IDS.claude),
    ).toEqual({
      id: AGENT_BACKEND_IDS.claude,
      label: CLAUDE_CODE_BEDROCK_LABEL,
      configurationMode: CLAUDE_CODE_BEDROCK_CONFIGURATION_MODE,
    })
    // Other backends stay unlabeled by Bedrock mode.
    expect(
      bedrock.find((entry) => entry.id === AGENT_BACKEND_IDS.grok)?.label,
    ).toBe("Grok Build")
  })

  it("declares typed capabilities for OpenCode, Grok Build, Codex Build, and Claude Code", () => {
    const opencode = getBuiltInAgentBackend(AGENT_BACKEND_IDS.opencode)
    expect(opencode).toBeDefined()
    expect(capabilitySupported(opencode!, "SessionTelemetry")).toBe(true)
    expect(capabilitySupported(opencode!, "KeymaxxerMcp")).toBe(true)

    const grok = getBuiltInAgentBackend(AGENT_BACKEND_IDS.grok)
    expect(grok).toBeDefined()
    expect(capabilitySupported(grok!, "SessionTelemetry")).toBe(true)
    expect(capabilitySupported(grok!, "KeymaxxerMcp")).toBe(false)

    const codex = getBuiltInAgentBackend(AGENT_BACKEND_IDS.codex)
    expect(codex).toBeDefined()
    expect(capabilitySupported(codex!, "SessionTelemetry")).toBe(true)
    expect(capabilitySupported(codex!, "KeymaxxerMcp")).toBe(false)

    const claude = getBuiltInAgentBackend(AGENT_BACKEND_IDS.claude)
    expect(claude).toBeDefined()
    expect(capabilitySupported(claude!, "SessionTelemetry")).toBe(true)
    expect(capabilitySupported(claude!, "KeymaxxerMcp")).toBe(false)
  })
})

describe("Agent-free Lifecycle Step classification", () => {
  it("classifies guaranteed Agent-free steps", () => {
    for (const step of [
      "create_worktree",
      "watch_pr_status_checks",
      "mark_pr_ready_for_review",
      "merge_pr",
      "close_issue",
      "local_cleanup",
    ]) {
      expect(isAgentFreeLifecycleStep(step)).toBe(true)
      expect(isAgentDependentLifecycleStep(step)).toBe(false)
    }
  })

  it("classifies agent-dependent steps", () => {
    for (const step of [
      "install_dependencies",
      "implement",
      "assess_changes",
      "pre_commit",
      "review",
      "commit",
      "create_pr",
      "resolve_pr_merge_conflict",
      "investigate_pr_status_checks",
      "decide_pr_merge",
    ]) {
      expect(isAgentDependentLifecycleStep(step)).toBe(true)
      expect(isAgentFreeLifecycleStep(step)).toBe(false)
    }
  })
})
