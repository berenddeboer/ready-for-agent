import {
  JOBS_COMPLETED_WINDOW_MS,
  type OperationalLifecycleStep,
  type StepRunStatus,
  type WorkItemState,
  filterWorkItemsByListKind,
  isJobsCompletedWorkItemState,
  isJobsFailedWorkItem,
  isJobsWorkingWorkItem,
  isRetryableNeedsHumanWorkItem,
} from "../src/lib/types.js"
import { describe, expect, it } from "bun:test"

const NOW_MS = Date.parse("2026-07-30T12:00:00.000Z")

const item = (
  state: WorkItemState,
  createdAtMs: number,
  latestStepStatus?: StepRunStatus,
  failureCode: string | null = null,
  latestStep?: OperationalLifecycleStep,
  stateReadyAtMs: number = createdAtMs,
) => ({
  state,
  failureCode,
  createdAt: new Date(createdAtMs),
  stateReadyAt: new Date(stateReadyAtMs),
  stepRuns:
    latestStepStatus === undefined
      ? []
      : [
          {
            status: latestStepStatus,
            ...(latestStep === undefined ? {} : { step: latestStep }),
          } as const,
        ],
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

  it("keeps nonterminal failed/interrupted Step Runs on Working", () => {
    for (const status of ["failed", "interrupted"] as const) {
      const stopped = item("implement", 1, status)
      expect(isJobsFailedWorkItem(stopped)).toBe(false)
      expect(isJobsWorkingWorkItem(stopped)).toBe(true)
    }
  })

  it("keeps the persisted retryable terminal failure on Working", () => {
    const retryable = item(
      "failed",
      1,
      "succeeded",
      "pr_status_checks_unresolved",
    )
    expect(isJobsFailedWorkItem(retryable)).toBe(false)
    expect(isJobsWorkingWorkItem(retryable)).toBe(true)
  })

  it("treats Investigate, Review, and missing-check Needs Human handoffs as retryable", () => {
    expect(
      isRetryableNeedsHumanWorkItem(
        item(
          "needs_human",
          1,
          "succeeded",
          null,
          "investigate_pr_status_checks",
        ),
      ),
    ).toBe(true)
    expect(
      isRetryableNeedsHumanWorkItem(
        item("needs_human", 1, "succeeded", null, "review"),
      ),
    ).toBe(true)
    expect(
      isRetryableNeedsHumanWorkItem({
        state: "needs_human",
        failureCode: null,
        createdAt: new Date(1),
        stateReadyAt: new Date(1),
        stepRuns: [
          {
            status: "succeeded",
            step: "watch_pr_status_checks",
            reasonCode: "missing_successful_checks",
          },
        ],
      }),
    ).toBe(true)
    expect(
      isRetryableNeedsHumanWorkItem(
        item("needs_human", 1, "succeeded", null, "decide_pr_merge"),
      ),
    ).toBe(false)
    expect(isRetryableNeedsHumanWorkItem(item("needs_human", 1))).toBe(false)
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
    item("complete", NOW_MS - 8000),
    item("implement", NOW_MS - 7000, "running"),
    item("needs_human", NOW_MS - 6000),
    item("failed", NOW_MS - 5000, "failed"),
    item("abandoned", NOW_MS - 4000),
    item("create_worktree", NOW_MS - 3000, "queued"),
    item("pre_commit", NOW_MS - 2000, "failed"),
    item("review", NOW_MS - 1000, "interrupted"),
  ]

  it("returns the input unchanged when listKind is omitted", () => {
    expect(filterWorkItemsByListKind(items, undefined)).toEqual(items)
  })

  it("filters Working to unfinished, retryable stoppages, and Needs Human", () => {
    expect(
      filterWorkItemsByListKind(items, "working").map((i) => i.state),
    ).toEqual([
      "implement",
      "needs_human",
      "create_worktree",
      "pre_commit",
      "review",
    ])
  })

  it("filters Failed to non-retryable terminal failures only", () => {
    expect(
      filterWorkItemsByListKind(items, "failed").map((i) => i.state),
    ).toEqual(["failed"])
  })

  it("filters Completed to Complete/Abandoned newest-first without terminal failed", () => {
    expect(
      filterWorkItemsByListKind(items, "completed", undefined, NOW_MS).map(
        (i) => i.state,
      ),
    ).toEqual(["abandoned", "complete"])
  })

  it("limits Failed to the newest N by createdAt", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      item("failed", index * 100, "failed"),
    )
    const limited = filterWorkItemsByListKind(many, "failed", 15)
    expect(limited).toHaveLength(15)
    expect(limited[0]!.createdAt.getTime()).toBe(1900)
    expect(limited[14]!.createdAt.getTime()).toBe(500)
  })

  it("includes every Completed item within the rolling 24h window without a fixed limit", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      item(
        index % 2 === 0 ? "complete" : "abandoned",
        NOW_MS - index * 60_000,
        undefined,
        null,
        undefined,
        NOW_MS - index * 60_000,
      ),
    )
    const filtered = filterWorkItemsByListKind(
      many,
      "completed",
      undefined,
      NOW_MS,
    )
    expect(filtered).toHaveLength(20)
    expect(filtered[0]!.stateReadyAt.getTime()).toBe(NOW_MS)
    expect(filtered[19]!.stateReadyAt.getTime()).toBe(NOW_MS - 19 * 60_000)
  })

  it("excludes Completed items whose stateReadyAt is older than 24 hours", () => {
    const recent = item(
      "complete",
      NOW_MS - 1_000,
      undefined,
      null,
      undefined,
      NOW_MS - 1_000,
    )
    const atBoundary = item(
      "abandoned",
      NOW_MS - JOBS_COMPLETED_WINDOW_MS,
      undefined,
      null,
      undefined,
      NOW_MS - JOBS_COMPLETED_WINDOW_MS,
    )
    const tooOld = item(
      "complete",
      NOW_MS - JOBS_COMPLETED_WINDOW_MS - 1,
      undefined,
      null,
      undefined,
      NOW_MS - JOBS_COMPLETED_WINDOW_MS - 1,
    )
    expect(
      filterWorkItemsByListKind(
        [recent, atBoundary, tooOld],
        "completed",
        undefined,
        NOW_MS,
      ).map((i) => i.stateReadyAt.getTime()),
    ).toEqual([
      recent.stateReadyAt.getTime(),
      atBoundary.stateReadyAt.getTime(),
    ])
  })

  it("orders Completed by stateReadyAt (completion), not createdAt", () => {
    const olderCompletion = item(
      "complete",
      NOW_MS - 10_000,
      undefined,
      null,
      undefined,
      NOW_MS - 2_000,
    )
    const newerCompletion = item(
      "abandoned",
      NOW_MS - 20_000,
      undefined,
      null,
      undefined,
      NOW_MS - 1_000,
    )
    expect(
      filterWorkItemsByListKind(
        [olderCompletion, newerCompletion],
        "completed",
        undefined,
        NOW_MS,
      ).map((i) => i.state),
    ).toEqual(["abandoned", "complete"])
  })

  it("applies optional limit after the Completed window, newest stateReadyAt first", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      item(
        index % 2 === 0 ? "complete" : "abandoned",
        NOW_MS - index * 60_000,
        undefined,
        null,
        undefined,
        NOW_MS - index * 60_000,
      ),
    )
    const limited = filterWorkItemsByListKind(many, "completed", 15, NOW_MS)
    expect(limited).toHaveLength(15)
    expect(limited[0]!.stateReadyAt.getTime()).toBe(NOW_MS)
    expect(limited[14]!.stateReadyAt.getTime()).toBe(NOW_MS - 14 * 60_000)
  })

  it("does not put Needs Human or Failed under Completed even with limit", () => {
    const mixed = [
      item("needs_human", NOW_MS - 1000),
      item("complete", NOW_MS - 2000),
      item("failed", NOW_MS - 3000, "failed"),
      item("implement", NOW_MS - 4000, "failed"),
      item("abandoned", NOW_MS - 5000),
    ]
    expect(
      filterWorkItemsByListKind(mixed, "completed", 15, NOW_MS).map(
        (i) => i.state,
      ),
    ).toEqual(["complete", "abandoned"])
  })

  it("puts retryable failures under Working, not terminal failures", () => {
    const mixed = [
      item("implement", 1000, "failed"),
      item("failed", 2000, "failed"),
      item("implement", 3000, "running"),
    ]
    expect(
      filterWorkItemsByListKind(mixed, "working").map((i) => i.state),
    ).toEqual(["implement", "implement"])
    expect(
      filterWorkItemsByListKind(mixed, "working")[0]!.stepRuns[0]!.status,
    ).toBe("failed")
  })
})
