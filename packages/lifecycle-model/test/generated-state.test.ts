import {
  OPERATIONAL_LIFECYCLE_STEPS,
  OperationalLifecycleStep,
  TERMINAL_WORK_ITEM_STATES,
  TerminalWorkItemState,
  WORK_ITEM_STATES,
  WorkItemState,
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
})
