import { Duration } from "effect"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  LIFECYCLE_STEP_AGENT_FREE,
  LIFECYCLE_STEP_RETRYABLE,
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

  it("preserves the previous agent-free Lifecycle Step classification", () => {
    expect(LIFECYCLE_STEP_AGENT_FREE).toEqual({
      assess_changes: false,
      close_issue: true,
      commit: false,
      create_pr: false,
      create_worktree: true,
      decide_pr_merge: false,
      implement: false,
      install_dependencies: false,
      investigate_pr_status_checks: false,
      local_cleanup: true,
      mark_pr_ready_for_review: true,
      merge_pr: true,
      pre_commit: false,
      resolve_pr_merge_conflict: false,
      review: false,
      watch_pr_status_checks: true,
    })
  })

  it("preserves the previous default maximum durations", () => {
    expect(
      Object.fromEntries(
        Object.entries(DEFAULT_LIFECYCLE_MAX_DURATIONS).map(
          ([step, duration]) => [step, Duration.toMillis(duration)],
        ),
      ),
    ).toEqual({
      assess_changes: 3_600_000,
      close_issue: 300_000,
      commit: 1_800_000,
      create_pr: 600_000,
      create_worktree: 300_000,
      decide_pr_merge: 900_000,
      implement: 7_200_000,
      install_dependencies: 900_000,
      investigate_pr_status_checks: 7_200_000,
      local_cleanup: 300_000,
      mark_pr_ready_for_review: 300_000,
      merge_pr: 300_000,
      pre_commit: 7_200_000,
      resolve_pr_merge_conflict: 7_200_000,
      review: 3_600_000,
      watch_pr_status_checks: 300_000,
    })
  })

  it("emits retryability for every operational Lifecycle Step", () => {
    expect(LIFECYCLE_STEP_RETRYABLE).toEqual(
      Object.fromEntries(
        OPERATIONAL_LIFECYCLE_STEPS.map((step) => [step, true]),
      ),
    )
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
