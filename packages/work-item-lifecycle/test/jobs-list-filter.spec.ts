import {
  type StepRunStatus,
  type WorkItemState,
  filterWorkItemsByListKind,
  isJobsCompletedWorkItemState,
  isJobsFailedWorkItem,
  isJobsWorkingWorkItem,
} from "../src/lib/types.js"
import { describe, expect, it } from "bun:test"

const item = (
  state: WorkItemState,
  createdAtMs: number,
  latestStepStatus?: StepRunStatus,
) => ({
  state,
  createdAt: new Date(createdAtMs),
  stepRuns:
    latestStepStatus === undefined
      ? []
      : [{ status: latestStepStatus } as const],
})

describe("Jobs list membership", () => {
  it("places Needs Human on Working, not Failed or Completed", () => {
    const needsHuman = item("needs_human", 1)
    expect(isJobsWorkingWorkItem(needsHuman)).toBe(true)
    expect(isJobsFailedWorkItem(needsHuman)).toBe(false)
    expect(isJobsCompletedWorkItemState("needs_human")).toBe(false)
  })

  it("places Complete and Abandoned only on Completed", () => {
    for (const state of ["complete", "abandoned"] as const) {
      expect(isJobsCompletedWorkItemState(state)).toBe(true)
      expect(isJobsFailedWorkItem(item(state, 1))).toBe(false)
      expect(isJobsWorkingWorkItem(item(state, 1))).toBe(false)
    }
  })

  it("places terminal failed only on Failed", () => {
    const failed = item("failed", 1, "failed")
    expect(isJobsFailedWorkItem(failed)).toBe(true)
    expect(isJobsWorkingWorkItem(failed)).toBe(false)
    expect(isJobsCompletedWorkItemState("failed")).toBe(false)
  })

  it("places nonterminal failed/interrupted Step Runs only on Failed", () => {
    for (const status of ["failed", "interrupted"] as const) {
      const stopped = item("implement", 1, status)
      expect(isJobsFailedWorkItem(stopped)).toBe(true)
      expect(isJobsWorkingWorkItem(stopped)).toBe(false)
    }
  })

  it("places unfinished lifecycle states on Working when not stopped on failure", () => {
    expect(isJobsWorkingWorkItem(item("implement", 1))).toBe(true)
    expect(isJobsWorkingWorkItem(item("implement", 1, "running"))).toBe(true)
    expect(isJobsWorkingWorkItem(item("create_worktree", 1, "queued"))).toBe(
      true,
    )
    expect(isJobsFailedWorkItem(item("implement", 1, "running"))).toBe(false)
  })
})

describe("filterWorkItemsByListKind", () => {
  const items = [
    item("complete", 1000),
    item("implement", 2000, "running"),
    item("needs_human", 3000),
    item("failed", 4000, "failed"),
    item("abandoned", 5000),
    item("create_worktree", 6000, "queued"),
    item("pre_commit", 7000, "failed"),
    item("review", 8000, "interrupted"),
  ]

  it("returns the input unchanged when listKind is omitted", () => {
    expect(filterWorkItemsByListKind(items, undefined)).toEqual(items)
  })

  it("filters Working to unfinished plus Needs Human, excluding failures", () => {
    expect(
      filterWorkItemsByListKind(items, "working").map((i) => i.state),
    ).toEqual(["implement", "needs_human", "create_worktree"])
  })

  it("filters Failed to terminal failed plus retriable stoppages, newest-first", () => {
    expect(
      filterWorkItemsByListKind(items, "failed").map((i) => i.state),
    ).toEqual(["review", "pre_commit", "failed"])
  })

  it("filters Completed to Complete/Abandoned newest-first without terminal failed", () => {
    expect(
      filterWorkItemsByListKind(items, "completed").map((i) => i.state),
    ).toEqual(["abandoned", "complete"])
  })

  it("limits Failed to the newest N by createdAt", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      item(index % 2 === 0 ? "failed" : "implement", index * 100, "failed"),
    )
    const limited = filterWorkItemsByListKind(many, "failed", 15)
    expect(limited).toHaveLength(15)
    expect(limited[0]!.createdAt.getTime()).toBe(1900)
    expect(limited[14]!.createdAt.getTime()).toBe(500)
  })

  it("limits Completed to the newest N by createdAt", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      item(index % 2 === 0 ? "complete" : "abandoned", index * 100),
    )
    const limited = filterWorkItemsByListKind(many, "completed", 15)
    expect(limited).toHaveLength(15)
    expect(limited[0]!.createdAt.getTime()).toBe(1900)
    expect(limited[14]!.createdAt.getTime()).toBe(500)
  })

  it("does not put Needs Human or Failed under Completed even with limit", () => {
    const mixed = [
      item("needs_human", 9000),
      item("complete", 8000),
      item("failed", 7000, "failed"),
      item("implement", 6000, "failed"),
      item("abandoned", 5000),
    ]
    expect(
      filterWorkItemsByListKind(mixed, "completed", 15).map((i) => i.state),
    ).toEqual(["complete", "abandoned"])
  })

  it("does not put Failed under Working", () => {
    const mixed = [
      item("implement", 1000, "failed"),
      item("failed", 2000, "failed"),
      item("implement", 3000, "running"),
    ]
    expect(
      filterWorkItemsByListKind(mixed, "working").map((i) => i.state),
    ).toEqual(["implement"])
    expect(
      filterWorkItemsByListKind(mixed, "working")[0]!.stepRuns[0]!.status,
    ).toBe("running")
  })
})
