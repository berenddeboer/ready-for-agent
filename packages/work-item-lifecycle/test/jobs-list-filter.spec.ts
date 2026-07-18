import {
  type WorkItemState,
  filterWorkItemsByListKind,
  isJobsCompletedWorkItemState,
  isJobsWorkingWorkItemState,
} from "../src/lib/types.js"
import { describe, expect, it } from "bun:test"

const item = (state: WorkItemState, createdAtMs: number) => ({
  state,
  createdAt: new Date(createdAtMs),
})

describe("Jobs list membership", () => {
  it("places Needs Human on Working, not Completed", () => {
    expect(isJobsWorkingWorkItemState("needs_human")).toBe(true)
    expect(isJobsCompletedWorkItemState("needs_human")).toBe(false)
  })

  it("places Complete, Failed, and Abandoned only on Completed", () => {
    for (const state of ["complete", "failed", "abandoned"] as const) {
      expect(isJobsCompletedWorkItemState(state)).toBe(true)
      expect(isJobsWorkingWorkItemState(state)).toBe(false)
    }
  })

  it("places unfinished lifecycle states on Working", () => {
    expect(isJobsWorkingWorkItemState("implement")).toBe(true)
    expect(isJobsWorkingWorkItemState("create_worktree")).toBe(true)
  })
})

describe("filterWorkItemsByListKind", () => {
  const items = [
    item("complete", 1000),
    item("implement", 2000),
    item("needs_human", 3000),
    item("failed", 4000),
    item("abandoned", 5000),
    item("create_worktree", 6000),
  ]

  it("returns the input unchanged when listKind is omitted", () => {
    expect(filterWorkItemsByListKind(items, undefined)).toEqual(items)
  })

  it("filters Working to unfinished plus Needs Human, preserving order", () => {
    expect(
      filterWorkItemsByListKind(items, "working").map((i) => i.state),
    ).toEqual(["implement", "needs_human", "create_worktree"])
  })

  it("filters Completed to Complete/Failed/Abandoned newest-first", () => {
    expect(
      filterWorkItemsByListKind(items, "completed").map((i) => i.state),
    ).toEqual(["abandoned", "failed", "complete"])
  })

  it("limits Completed to the newest N by createdAt", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      item(index % 2 === 0 ? "complete" : "failed", index * 100),
    )
    const limited = filterWorkItemsByListKind(many, "completed", 15)
    expect(limited).toHaveLength(15)
    expect(limited[0]!.createdAt.getTime()).toBe(1900)
    expect(limited[14]!.createdAt.getTime()).toBe(500)
  })

  it("does not put Needs Human under Completed even with limit", () => {
    const mixed = [
      item("needs_human", 9000),
      item("complete", 8000),
      item("failed", 7000),
    ]
    expect(
      filterWorkItemsByListKind(mixed, "completed", 15).map((i) => i.state),
    ).toEqual(["complete", "failed"])
  })
})
