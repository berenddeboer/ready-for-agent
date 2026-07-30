import { readFileSync } from "node:fs"
import { join } from "node:path"
import { canShowWorkItemResetAction } from "../src/work-item-job-actions.js"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const lifecycleStatusSource = (): string => {
  const source = homeSource()
  const start = source.indexOf("function WorkItemLifecycleStatus(")
  expect(start).toBeGreaterThan(-1)
  return source.slice(start)
}

/** Scenario labels document projected GraphQL status; the gate keys on isTerminal. */
const cases = [
  {
    name: "terminal COMPLETE history",
    args: { compact: true, isTerminal: true, isNeedsHuman: false },
    show: false,
  },
  {
    name: "terminal ABANDONED history",
    args: { compact: true, isTerminal: true, isNeedsHuman: false },
    show: false,
  },
  {
    name: "terminal FAILED history",
    args: { compact: true, isTerminal: true, isNeedsHuman: false },
    show: false,
  },
  {
    name: "held WAITING_FOR_BLOCKERS (non-terminal)",
    args: { compact: true, isTerminal: false, isNeedsHuman: false },
    show: true,
  },
  {
    name: "held WAITING_FOR_WORKER_SLOT (non-terminal)",
    args: { compact: true, isTerminal: false, isNeedsHuman: false },
    show: true,
  },
  {
    name: "RUNNING (non-terminal)",
    args: { compact: true, isTerminal: false, isNeedsHuman: false },
    show: true,
  },
  {
    // Step-level failure while the Work Item is still operational: GraphQL status
    // can be FAILED/INTERRUPTED with isTerminal false. Must still show Reset.
    name: "step-level FAILED status on non-terminal work item",
    args: { compact: true, isTerminal: false, isNeedsHuman: false },
    show: true,
  },
  {
    name: "step-level INTERRUPTED status on non-terminal work item",
    args: { compact: true, isTerminal: false, isNeedsHuman: false },
    show: true,
  },
  {
    name: "paused NEEDS_HUMAN_REVIEW (non-terminal Working)",
    args: { compact: true, isTerminal: false, isNeedsHuman: false },
    show: true,
  },
  {
    name: "terminal NEEDS_HUMAN Working handoff",
    args: { compact: true, isTerminal: true, isNeedsHuman: true },
    show: true,
  },
  {
    name: "non-compact issue row (held)",
    args: { compact: false, isTerminal: false, isNeedsHuman: false },
    show: false,
  },
  {
    name: "non-compact issue row (Needs Human)",
    args: { compact: false, isTerminal: true, isNeedsHuman: true },
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
    expect(lifecycle).toContain("resetWorkItem")
    expect(lifecycle).toContain(
      'aria-label={reset.isPending ? "Resetting job" : "Reset job"}',
    )
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
    expect(lifecycle).not.toMatch(
      /canShowWorkItemResetAction[\s\S]*?status\s*!==\s*"FAILED"/,
    )
  })

  test("Jobs Completed tab still renders compact lifecycle status", () => {
    const source = homeSource()
    expect(source).toContain('listKind: "COMPLETED"')
    expect(source).toContain("JOBS_COMPLETED_WINDOW_HOURS")
    expect(source).not.toContain("JOBS_COMPLETED_LIMIT")
    const jobsCard = source.slice(
      source.indexOf("function JobsCard("),
      source.indexOf("function WorkItemPauseButton("),
    )
    expect(jobsCard).toContain("<WorkItemLifecycleStatus")
    expect(jobsCard).toContain("compact")
    // Homepage isolation: Kanban Merged-lane summary must not leak here.
    expect(jobsCard).not.toContain("PipelineCompleteSummary")
    expect(jobsCard).not.toContain("totalElapsedMs")
  })
})
