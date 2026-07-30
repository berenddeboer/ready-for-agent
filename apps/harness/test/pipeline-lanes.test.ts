import {
  PIPELINE_LANES,
  type PipelineLaneId,
  pipelineLaneFor,
} from "../src/pipeline-lanes.js"
import { describe, expect, test } from "bun:test"

type LaneCase = {
  readonly state: string
  readonly status: string
  readonly lane: PipelineLaneId
}

describe("PIPELINE_LANES", () => {
  test("defines the ordered pipeline lanes and their fixed colors", () => {
    expect(
      PIPELINE_LANES.map(({ id, label, color }) => ({ id, label, color })),
    ).toEqual([
      { id: "queue", label: "Queue", color: "#ffd21c" },
      { id: "build", label: "Build", color: "#1976d2" },
      { id: "review", label: "Review", color: "#7654b5" },
      { id: "pr", label: "PR", color: "#168b62" },
      { id: "attention", label: "Attention", color: "#ff4d1c" },
      { id: "complete", label: "Merged", color: "#151515" },
    ])
  })
})

describe("pipelineLaneFor", () => {
  test.each([
    { state: "REVIEW", status: "FAILED", lane: "attention" },
    { state: "IMPLEMENT", status: "INTERRUPTED", lane: "attention" },
    { state: "MERGE_PR", status: "NEEDS_HUMAN", lane: "attention" },
    {
      state: "WATCH_PR_STATUS_CHECKS",
      status: "NEEDS_HUMAN_REVIEW",
      lane: "attention",
    },
    { state: "FAILED", status: "RUNNING", lane: "attention" },
    { state: "NEEDS_HUMAN", status: "RUNNING", lane: "attention" },
  ] satisfies readonly LaneCase[])(
    "places $state with $status in Attention",
    ({ state, status, lane }) => {
      expect(pipelineLaneFor({ state, status })).toBe(lane)
    },
  )

  test.each([
    { state: "MERGE_PR", status: "SUCCEEDED", lane: "complete" },
    { state: "LOCAL_CLEANUP", status: "COMPLETE", lane: "complete" },
    { state: "MERGE_PR", status: "ABANDONED", lane: "complete" },
    { state: "COMPLETE", status: "RUNNING", lane: "complete" },
    { state: "ABANDONED", status: "RUNNING", lane: "complete" },
  ] satisfies readonly LaneCase[])(
    "places $state with $status in Merged",
    ({ state, status, lane }) => {
      expect(pipelineLaneFor({ state, status })).toBe(lane)
    },
  )

  test.each([
    {
      state: "CREATE_WORKTREE",
      status: "WAITING_FOR_BLOCKERS",
      lane: "queue",
    },
    {
      state: "CREATE_WORKTREE",
      status: "WAITING_FOR_WORKER_SLOT",
      lane: "queue",
    },
    {
      state: "INSTALL_DEPENDENCIES",
      status: "WAITING_FOR_WORKER_SLOT",
      lane: "queue",
    },
    {
      state: "MERGE_PR",
      status: "WAITING_FOR_WORKER_SLOT",
      lane: "queue",
    },
  ] satisfies readonly LaneCase[])(
    "places blocked or not-admitted $state with $status in Queue",
    ({ state, status, lane }) => {
      expect(pipelineLaneFor({ state, status })).toBe(lane)
    },
  )

  test.each([
    { state: "CREATE_WORKTREE", status: "RUNNING", lane: "build" },
    { state: "INSTALL_DEPENDENCIES", status: "RUNNING", lane: "build" },
    { state: "IMPLEMENT", status: "RUNNING", lane: "build" },
    { state: "ASSESS_CHANGES", status: "RUNNING", lane: "build" },
    { state: "PRE_COMMIT", status: "RUNNING", lane: "build" },
    { state: "CREATE_WORKTREE", status: "QUEUED", lane: "build" },
    { state: "IMPLEMENT", status: "QUEUED", lane: "build" },
    { state: "PRE_COMMIT", status: "QUEUED", lane: "build" },
  ] satisfies readonly LaneCase[])(
    "places $state with $status in Build",
    ({ state, status, lane }) => {
      expect(pipelineLaneFor({ state, status })).toBe(lane)
    },
  )

  test.each([
    { state: "REVIEW", status: "RUNNING", lane: "review" },
    { state: "REVIEW", status: "QUEUED", lane: "review" },
  ] satisfies readonly LaneCase[])(
    "places $state with $status in Review",
    ({ state, status, lane }) => {
      expect(pipelineLaneFor({ state, status })).toBe(lane)
    },
  )

  test.each([
    { state: "COMMIT", status: "RUNNING", lane: "pr" },
    { state: "CREATE_PR", status: "RUNNING", lane: "pr" },
    { state: "WATCH_PR_STATUS_CHECKS", status: "RUNNING", lane: "pr" },
    {
      state: "WATCH_PR_STATUS_CHECKS",
      status: "QUEUED",
      lane: "pr",
    },
    {
      state: "RESOLVE_PR_MERGE_CONFLICT",
      status: "RUNNING",
      lane: "pr",
    },
    {
      state: "INVESTIGATE_PR_STATUS_CHECKS",
      status: "RUNNING",
      lane: "pr",
    },
    {
      state: "MARK_PR_READY_FOR_REVIEW",
      status: "RUNNING",
      lane: "pr",
    },
    { state: "DECIDE_PR_MERGE", status: "RUNNING", lane: "pr" },
    { state: "MERGE_PR", status: "RUNNING", lane: "pr" },
    { state: "MERGE_PR", status: "QUEUED", lane: "pr" },
    { state: "CLOSE_ISSUE", status: "RUNNING", lane: "pr" },
    { state: "LOCAL_CLEANUP", status: "RUNNING", lane: "pr" },
    { state: "COMMIT", status: "QUEUED", lane: "pr" },
    { state: "CREATE_PR", status: "QUEUED", lane: "pr" },
    { state: "MERGE_PR", status: "CANCELLED", lane: "pr" },
  ] satisfies readonly LaneCase[])(
    "places $state with $status in PR",
    ({ state, status, lane }) => {
      expect(pipelineLaneFor({ state, status })).toBe(lane)
    },
  )

  test.each([
    { state: "COMPLETE", status: "FAILED", lane: "attention" },
    {
      state: "CREATE_WORKTREE",
      status: "SUCCEEDED",
      lane: "complete",
    },
    {
      state: "WATCH_PR_STATUS_CHECKS",
      status: "FAILED",
      lane: "attention",
    },
    {
      state: "IMPLEMENT",
      status: "WAITING_FOR_WORKER_SLOT",
      lane: "queue",
    },
  ] satisfies readonly LaneCase[])(
    "applies precedence to $state with $status",
    ({ state, status, lane }) => {
      expect(pipelineLaneFor({ state, status })).toBe(lane)
    },
  )

  test("does not move a pending status-check poll between Queue and PR", () => {
    expect(
      pipelineLaneFor({
        state: "WATCH_PR_STATUS_CHECKS",
        status: "RUNNING",
      }),
    ).toBe("pr")
    expect(
      pipelineLaneFor({
        state: "WATCH_PR_STATUS_CHECKS",
        status: "QUEUED",
      }),
    ).toBe("pr")
  })
})
