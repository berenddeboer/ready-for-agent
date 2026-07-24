import {
  AGENT_BACKEND_IDS,
  capabilitySupported,
  defaultAgentBackendId,
  getBuiltInAgentBackend,
  isAgentDependentLifecycleStep,
  isAgentFreeLifecycleStep,
  listBuiltInAgentBackends,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("Agent Backend registry", () => {
  it("exposes only OpenCode as a selectable production backend", () => {
    const backends = listBuiltInAgentBackends()
    expect(backends.map((entry) => entry.descriptor.id)).toEqual([
      AGENT_BACKEND_IDS.opencode,
    ])
    expect(defaultAgentBackendId).toBe(AGENT_BACKEND_IDS.opencode)
    expect(getBuiltInAgentBackend("missing")).toBeUndefined()
  })

  it("declares typed capabilities for OpenCode", () => {
    const opencode = getBuiltInAgentBackend(AGENT_BACKEND_IDS.opencode)
    expect(opencode).toBeDefined()
    expect(capabilitySupported(opencode!, "SessionTelemetry")).toBe(true)
    expect(capabilitySupported(opencode!, "KeymaxxerMcp")).toBe(true)
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
