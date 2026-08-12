import {
  JOBS_COMPLETED_WINDOW_MS,
  type WorkItemState,
} from "@ready-for-agent/work-item-lifecycle"
import {
  KANBAN_FAILED_LIMIT,
  KANBAN_LANES,
  buildKanbanSourceSet,
  kanbanLaneFor,
  projectKanbanLanes,
} from "../src/lib/kanban-projection.js"
import { describe, expect, test } from "bun:test"

const NOW_MS = Date.parse("2026-08-12T12:00:00.000Z")

type Fixture = {
  readonly id: string
  readonly repositoryId: string
  readonly state: WorkItemState
  readonly status: string
  readonly failureCode?: string | null
  readonly createdAt: Date
  readonly stateReadyAt: Date
}

const item = (
  overrides: Partial<Fixture> & Pick<Fixture, "id" | "state" | "status">,
): Fixture => ({
  repositoryId: "repo-a",
  failureCode: null,
  createdAt: new Date(NOW_MS),
  stateReadyAt: new Date(NOW_MS),
  ...overrides,
})

describe("KANBAN_LANES", () => {
  test("defines six fixed lanes in operator order", () => {
    expect(KANBAN_LANES.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "QUEUE", label: "Queue" },
      { id: "BUILD", label: "Build" },
      { id: "REVIEW", label: "Review" },
      { id: "PR", label: "PR" },
      { id: "ATTENTION", label: "Attention" },
      { id: "MERGED", label: "Merged" },
    ])
  })
})

describe("kanbanLaneFor", () => {
  test.each([
    { state: "review", status: "failed", lane: "ATTENTION" },
    { state: "implement", status: "interrupted", lane: "ATTENTION" },
    { state: "merge_pr", status: "needs_human", lane: "ATTENTION" },
    {
      state: "watch_pr_status_checks",
      status: "needs_human_review",
      lane: "ATTENTION",
    },
    { state: "failed", status: "running", lane: "ATTENTION" },
    { state: "needs_human", status: "running", lane: "ATTENTION" },
    { state: "COMPLETE", status: "FAILED", lane: "ATTENTION" },
  ] as const)(
    "places $state / $status in Attention",
    ({ state, status, lane }) => {
      expect(kanbanLaneFor({ state, status })).toBe(lane)
    },
  )

  test.each([
    { state: "merge_pr", status: "succeeded", lane: "MERGED" },
    { state: "local_cleanup", status: "complete", lane: "MERGED" },
    { state: "merge_pr", status: "abandoned", lane: "MERGED" },
    { state: "complete", status: "running", lane: "MERGED" },
    { state: "abandoned", status: "running", lane: "MERGED" },
  ] as const)(
    "places $state / $status in Merged",
    ({ state, status, lane }) => {
      expect(kanbanLaneFor({ state, status })).toBe(lane)
    },
  )

  test.each([
    {
      state: "create_worktree",
      status: "waiting_for_blockers",
      lane: "QUEUE",
    },
    {
      state: "create_worktree",
      status: "waiting_for_worker_slot",
      lane: "QUEUE",
    },
    {
      state: "implement",
      status: "waiting_for_worker_slot",
      lane: "QUEUE",
    },
    {
      state: "merge_pr",
      status: "waiting_for_worker_slot",
      lane: "QUEUE",
    },
  ] as const)(
    "places blocked or not-admitted $state in Queue",
    ({ state, status, lane }) => {
      expect(kanbanLaneFor({ state, status })).toBe(lane)
    },
  )

  test.each([
    { state: "create_worktree", status: "running", lane: "BUILD" },
    { state: "install_dependencies", status: "running", lane: "BUILD" },
    { state: "implement", status: "running", lane: "BUILD" },
    { state: "assess_changes", status: "running", lane: "BUILD" },
    { state: "pre_commit", status: "queued", lane: "BUILD" },
    { state: "review", status: "queued", lane: "REVIEW" },
    { state: "watch_pr_status_checks", status: "queued", lane: "PR" },
    { state: "commit", status: "running", lane: "PR" },
    { state: "create_pr", status: "queued", lane: "PR" },
    { state: "merge_pr", status: "cancelled", lane: "PR" },
  ] as const)(
    "places lifecycle progress $state / $status in $lane",
    ({ state, status, lane }) => {
      expect(kanbanLaneFor({ state, status })).toBe(lane)
    },
  )

  test("does not send a pending status-check poll to Queue", () => {
    expect(
      kanbanLaneFor({
        state: "WATCH_PR_STATUS_CHECKS",
        status: "QUEUED",
      }),
    ).toBe("PR")
  })
})

describe("buildKanbanSourceSet", () => {
  test("includes working, newest 15 terminal failures, and 24h completed", () => {
    const working = item({
      id: "w1",
      state: "implement",
      status: "running",
      createdAt: new Date(NOW_MS - 1_000),
    })
    const needsHuman = item({
      id: "nh1",
      state: "needs_human",
      status: "needs_human",
      createdAt: new Date(NOW_MS - 2_000),
    })
    const completed = item({
      id: "c1",
      state: "complete",
      status: "complete",
      stateReadyAt: new Date(NOW_MS - 60_000),
      createdAt: new Date(NOW_MS - 3_000),
    })
    const oldCompleted = item({
      id: "c-old",
      state: "complete",
      status: "complete",
      stateReadyAt: new Date(NOW_MS - JOBS_COMPLETED_WINDOW_MS - 1),
      createdAt: new Date(NOW_MS - 4_000),
    })
    const failed = Array.from({ length: KANBAN_FAILED_LIMIT + 3 }, (_, i) =>
      item({
        id: `f${i}`,
        state: "failed",
        status: "failed",
        createdAt: new Date(NOW_MS - i * 1_000),
      }),
    )

    const source = buildKanbanSourceSet(
      [working, needsHuman, completed, oldCompleted, ...failed],
      NOW_MS,
    )
    const ids = new Set(source.map((entry) => entry.id))

    expect(ids.has("w1")).toBe(true)
    expect(ids.has("nh1")).toBe(true)
    expect(ids.has("c1")).toBe(true)
    expect(ids.has("c-old")).toBe(false)
    expect(
      source
        .filter((entry) => entry.state === "failed")
        .map((entry) => entry.id),
    ).toEqual(Array.from({ length: KANBAN_FAILED_LIMIT }, (_, i) => `f${i}`))
  })

  test("deduplicates by Work Item id", () => {
    const shared = item({
      id: "shared",
      state: "implement",
      status: "running",
    })
    const source = buildKanbanSourceSet([shared, shared], NOW_MS)
    expect(source).toHaveLength(1)
  })
})

describe("projectKanbanLanes", () => {
  test("returns empty lanes in fixed order", () => {
    const lanes = projectKanbanLanes([])
    expect(lanes.map((lane) => ({ id: lane.id, count: lane.count }))).toEqual([
      { id: "QUEUE", count: 0 },
      { id: "BUILD", count: 0 },
      { id: "REVIEW", count: 0 },
      { id: "PR", count: 0 },
      { id: "ATTENTION", count: 0 },
      { id: "MERGED", count: 0 },
    ])
    for (const lane of lanes) {
      expect(lane.workItems).toEqual([])
    }
  })

  test("orders non-Merged lanes by createdAt newest first", () => {
    const older = item({
      id: "older",
      state: "implement",
      status: "running",
      createdAt: new Date(NOW_MS - 10_000),
    })
    const newer = item({
      id: "newer",
      state: "implement",
      status: "running",
      createdAt: new Date(NOW_MS - 1_000),
    })
    const lanes = projectKanbanLanes([older, newer])
    const build = lanes.find((lane) => lane.id === "BUILD")
    expect(build?.workItems.map((entry) => entry.id)).toEqual([
      "newer",
      "older",
    ])
  })

  test("orders Merged by stateReadyAt newest first", () => {
    const older = item({
      id: "older-merged",
      state: "complete",
      status: "complete",
      createdAt: new Date(NOW_MS - 1_000),
      stateReadyAt: new Date(NOW_MS - 10_000),
    })
    const newer = item({
      id: "newer-merged",
      state: "complete",
      status: "complete",
      createdAt: new Date(NOW_MS - 20_000),
      stateReadyAt: new Date(NOW_MS - 1_000),
    })
    const lanes = projectKanbanLanes([older, newer])
    const merged = lanes.find((lane) => lane.id === "MERGED")
    expect(merged?.workItems.map((entry) => entry.id)).toEqual([
      "newer-merged",
      "older-merged",
    ])
  })

  test("Attention mixes working and failed by createdAt newest first", () => {
    const workingAttention = item({
      id: "working-attention",
      state: "implement",
      status: "failed",
      createdAt: new Date(NOW_MS - 5_000),
    })
    const terminalFailed = item({
      id: "terminal-failed",
      state: "failed",
      status: "failed",
      createdAt: new Date(NOW_MS - 1_000),
    })
    const lanes = projectKanbanLanes([workingAttention, terminalFailed])
    const attention = lanes.find((lane) => lane.id === "ATTENTION")
    expect(attention?.workItems.map((entry) => entry.id)).toEqual([
      "terminal-failed",
      "working-attention",
    ])
  })
})
