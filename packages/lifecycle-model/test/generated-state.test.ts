import { resolve } from "node:path"
import {
  OPERATIONAL_LIFECYCLE_STEPS,
  OperationalLifecycleStep,
  TERMINAL_WORK_ITEM_STATES,
  TerminalWorkItemState,
  WORK_ITEM_STATES,
  WorkItemState,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const existingDeclarationsPath = resolve(
  import.meta.dir,
  "../../work-item-lifecycle/src/lib/types.ts",
)
const {
  OperationalLifecycleStep: ExistingOperationalLifecycleStep,
  TerminalWorkItemState: ExistingTerminalWorkItemState,
} = await import(existingDeclarationsPath)

const sorted = (values: readonly string[]) => [...values].sort()

describe("generated lifecycle state", () => {
  it("matches the existing hand-written state space", () => {
    expect(OPERATIONAL_LIFECYCLE_STEPS).toEqual(
      sorted(ExistingOperationalLifecycleStep.literals),
    )
    expect(TERMINAL_WORK_ITEM_STATES).toEqual(
      sorted(ExistingTerminalWorkItemState.literals),
    )
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
