import { readFileSync } from "node:fs"
import { join } from "node:path"
import { canShowWorkItemResetAction } from "../src/work-item-job-actions.js"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const lifecycleStatusSource = (): string => {
  const source = homeSource()
  const start = source.indexOf("function WorkItemLifecycleStatus(")
  expect(start).toBeGreaterThan(-1)
  return source.slice(start)
}

/**
 * Scenario labels document projected GraphQL status; the gate keys on isTerminal,
 * isNeedsHuman, and isFailed (not free-form status denylists).
 */
const cases = [
  {
    name: "terminal COMPLETE history",
    args: {
      compact: true,
      isTerminal: true,
      isNeedsHuman: false,
      isFailed: false,
    },
    show: false,
  },
  {
    name: "terminal ABANDONED history",
    args: {
      compact: true,
      isTerminal: true,
      isNeedsHuman: false,
      isFailed: false,
    },
    show: false,
  },
  {
    name: "terminal FAILED history",
    args: {
      compact: true,
      isTerminal: true,
      isNeedsHuman: false,
      isFailed: true,
    },
    show: true,
  },
  {
    name: "held WAITING_FOR_BLOCKERS (non-terminal)",
    args: {
      compact: true,
      isTerminal: false,
      isNeedsHuman: false,
      isFailed: false,
    },
    show: true,
  },
  {
    name: "held WAITING_FOR_WORKER_SLOT (non-terminal)",
    args: {
      compact: true,
      isTerminal: false,
      isNeedsHuman: false,
      isFailed: false,
    },
    show: true,
  },
  {
    name: "RUNNING (non-terminal)",
    args: {
      compact: true,
      isTerminal: false,
      isNeedsHuman: false,
      isFailed: false,
    },
    show: true,
  },
  {
    // Step-level failure while the Work Item is still operational: GraphQL status
    // can be FAILED/INTERRUPTED with isTerminal false. Must still show Reset.
    name: "step-level FAILED status on non-terminal work item",
    args: {
      compact: true,
      isTerminal: false,
      isNeedsHuman: false,
      isFailed: true,
    },
    show: true,
  },
  {
    name: "step-level INTERRUPTED status on non-terminal work item",
    args: {
      compact: true,
      isTerminal: false,
      isNeedsHuman: false,
      isFailed: false,
    },
    show: true,
  },
  {
    name: "paused NEEDS_HUMAN_REVIEW (non-terminal Working)",
    args: {
      compact: true,
      isTerminal: false,
      isNeedsHuman: false,
      isFailed: false,
    },
    show: true,
  },
  {
    name: "terminal NEEDS_HUMAN Working handoff",
    args: {
      compact: true,
      isTerminal: true,
      isNeedsHuman: true,
      isFailed: false,
    },
    show: true,
  },
  {
    name: "non-compact issue row (held)",
    args: {
      compact: false,
      isTerminal: false,
      isNeedsHuman: false,
      isFailed: false,
    },
    show: false,
  },
  {
    name: "non-compact issue row (Needs Human)",
    args: {
      compact: false,
      isTerminal: true,
      isNeedsHuman: true,
      isFailed: false,
    },
    show: false,
  },
  {
    name: "non-compact issue row (terminal Failed)",
    args: {
      compact: false,
      isTerminal: true,
      isNeedsHuman: false,
      isFailed: true,
    },
    show: false,
  },
] as const

describe("canShowWorkItemResetAction", () => {
  for (const scenario of cases) {
    test(scenario.name, () => {
      expect(canShowWorkItemResetAction(scenario.args)).toBe(scenario.show)
    })
  }
})

describe("Jobs Reset button wiring", () => {
  test("WorkItemLifecycleStatus uses the shared Reset visibility helper", () => {
    const lifecycle = lifecycleStatusSource()
    expect(lifecycle).toContain("canShowWorkItemResetAction({")
    expect(lifecycle).toContain("isTerminal: workItem.isTerminal")
    expect(lifecycle).toContain('isNeedsHuman: status === "NEEDS_HUMAN"')
    expect(lifecycle).toContain('isFailed: status === "FAILED"')
    expect(lifecycle).toContain("resetWorkItem")
    expect(lifecycle).toContain("<WorkItemResetButton")
    expect(lifecycle).toContain("pending={reset.isPending}")
    expect(lifecycle).toContain("disabled={actionsPending}")
    expect(lifecycle).toContain("onReset={() => reset.mutate()}")
  })

  test("held Queue rows are not denylisted for Reset the way Retry is", () => {
    const lifecycle = lifecycleStatusSource()
    expect(lifecycle).toContain(
      'const heldForBlockers = status === "WAITING_FOR_BLOCKERS"',
    )
    expect(lifecycle).toContain(
      "const canRetry = compact && workItem.canRetry && !heldForBlockers",
    )
    expect(lifecycle).not.toContain("canReset = compact && !heldForBlockers")
    // Gate must not denylist projected FAILED status strings (step failures).
    // Terminal Failed is allowed via isFailed; non-terminal step FAILED uses the
    // non-terminal branch. Neither path filters with status !== "FAILED".
    expect(lifecycle).not.toMatch(
      /canShowWorkItemResetAction[\s\S]*?status\s*!==\s*"FAILED"/,
    )
  })

  test("kanban completed tickets still render compact lifecycle outside Merged lane", () => {
    const source = homeSource()
    const board = readFileSync(
      join(import.meta.dir, "../src/kanban-board.tsx"),
      "utf8",
    )
    expect(source).toContain('listKind: "COMPLETED"')
    expect(source).toContain("JOBS_COMPLETED_WINDOW_HOURS")
    expect(source).not.toContain("JOBS_COMPLETED_LIMIT")
    // Non-Merged pipeline tickets keep compact lifecycle + Reset wiring.
    const ticket = board.slice(
      board.indexOf("function PipelineTicket("),
      board.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain("<WorkItemLifecycleStatus")
    expect(ticket).toContain("compact")
    // Merged lane uses the start/elapsed summary instead.
    expect(board).toContain("function PipelineCompleteSummary(")
    expect(board).toContain("totalElapsedMs")
  })
})
