import {
  LIFECYCLE_TRANSITIONS,
  OPERATIONAL_LIFECYCLE_STEPS,
  OperationalLifecycleStep,
  TERMINAL_WORK_ITEM_STATES,
  TerminalWorkItemState,
  WORK_ITEM_STATES,
  WorkItemState,
  isDeclaredLifecycleTransition,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("generated lifecycle state", () => {
  it("composes the complete state space from operational and terminal states", () => {
    expect(WORK_ITEM_STATES).toEqual([
      ...OPERATIONAL_LIFECYCLE_STEPS,
      ...TERMINAL_WORK_ITEM_STATES,
    ])
  })

  it("exports schemas backed by the generated typed arrays", () => {
    expect(OperationalLifecycleStep.literals).toEqual(
      OPERATIONAL_LIFECYCLE_STEPS,
    )
    expect(TerminalWorkItemState.literals).toEqual(TERMINAL_WORK_ITEM_STATES)
    expect(WorkItemState.literals).toEqual(WORK_ITEM_STATES)
  })

  it("exports the ontology transition relation as queryable data", () => {
    expect(LIFECYCLE_TRANSITIONS.length).toBeGreaterThan(0)
    expect(
      isDeclaredLifecycleTransition("create_worktree", "install_dependencies"),
    ).toBe(true)
    expect(isDeclaredLifecycleTransition("assess_changes", "close_issue")).toBe(
      true,
    )
    expect(
      isDeclaredLifecycleTransition(
        "watch_pr_status_checks",
        "resolve_pr_merge_conflict",
      ),
    ).toBe(true)
    expect(isDeclaredLifecycleTransition("local_cleanup", "complete")).toBe(
      true,
    )
  })

  it("does not infer undeclared pairs from the state space", () => {
    expect(isDeclaredLifecycleTransition("create_worktree", "complete")).toBe(
      false,
    )
  })

  it("emits complete, non-duplicated transition records", () => {
    const states = new Set<string>(WORK_ITEM_STATES)
    const exactRecords = new Set<string>()

    for (const transition of LIFECYCLE_TRANSITIONS) {
      expect(states.has(transition.from)).toBe(true)
      expect(states.has(transition.to)).toBe(true)
      expect(transition.guard.length).toBeGreaterThan(0)
      expect(transition.reasonCode.length).toBeGreaterThan(0)
      exactRecords.add(JSON.stringify(transition))
    }

    expect(exactRecords.size).toBe(LIFECYCLE_TRANSITIONS.length)
  })
})
