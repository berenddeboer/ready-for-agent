import {
  type LifecycleLabelChip,
  type LifecyclePipelineLaneId,
  PIPELINE_LANES,
  type PipelineLaneId,
  earlierLifecycleLanes,
  lifecycleFocusLaneFor,
  lifecycleLaneForPhase,
  lifecycleLaneForState,
  pipelineLaneFor,
  planLifecycleChipPresentation,
  sumLaneDurationMs,
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
      state: "WATCH_PR_STATUS_CHECKS",
      status: "WAITING_FOR_GITHUB",
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

describe("lifecycleLaneForPhase", () => {
  test.each([
    ["CREATE_WORKTREE", "build"],
    ["INSTALL_DEPENDENCIES", "build"],
    ["IMPLEMENT", "build"],
    ["ASSESS_CHANGES", "build"],
    ["PRE_COMMIT", "build"],
    ["REVIEW", "review"],
    ["COMMIT", "pr"],
    ["CREATE_PR", "pr"],
    ["WATCH_PR_STATUS_CHECKS", "pr"],
    ["INVESTIGATE_PR_STATUS_CHECKS", "pr"],
    ["GITHUB_STATUS_CHECKS", "pr"],
    ["RESOLVE_PR_MERGE_CONFLICT", "pr"],
    ["MARK_PR_READY_FOR_REVIEW", "pr"],
    ["DECIDE_PR_MERGE", "pr"],
    ["MERGE_PR", "pr"],
    ["CLOSE_ISSUE", "pr"],
    ["LOCAL_CLEANUP", "pr"],
  ] as const)("maps phase %s to %s", (phase, lane) => {
    expect(lifecycleLaneForPhase(phase)).toBe(lane)
  })

  test("returns null for unknown phases", () => {
    expect(lifecycleLaneForPhase("UNKNOWN_PHASE")).toBeNull()
  })
})

describe("lifecycleLaneForState", () => {
  test("mirrors Build / Review / PR placement sets without status overrides", () => {
    expect(lifecycleLaneForState("IMPLEMENT")).toBe("build")
    expect(lifecycleLaneForState("REVIEW")).toBe("review")
    expect(lifecycleLaneForState("CREATE_PR")).toBe("pr")
    expect(lifecycleLaneForState("FAILED")).toBeNull()
    expect(lifecycleLaneForState("NEEDS_HUMAN")).toBeNull()
  })
})

describe("lifecycleFocusLaneFor", () => {
  test("uses lifecycle state for Build / Review / PR tickets", () => {
    expect(
      lifecycleFocusLaneFor({ state: "IMPLEMENT", status: "RUNNING" }),
    ).toBe("build")
    expect(lifecycleFocusLaneFor({ state: "REVIEW", status: "QUEUED" })).toBe(
      "review",
    )
    expect(
      lifecycleFocusLaneFor({
        state: "WATCH_PR_STATUS_CHECKS",
        status: "RUNNING",
      }),
    ).toBe("pr")
  })

  test("Attention tickets still focus the lifecycle lane from state", () => {
    expect(lifecycleFocusLaneFor({ state: "REVIEW", status: "FAILED" })).toBe(
      "review",
    )
    expect(
      lifecycleFocusLaneFor({
        state: "MERGE_PR",
        status: "NEEDS_HUMAN",
      }),
    ).toBe("pr")
    expect(
      lifecycleFocusLaneFor({
        state: "IMPLEMENT",
        status: "INTERRUPTED",
      }),
    ).toBe("build")
  })

  test("Queue hold statuses disable chip-collapse focus", () => {
    expect(
      lifecycleFocusLaneFor({
        state: "CREATE_WORKTREE",
        status: "WAITING_FOR_BLOCKERS",
      }),
    ).toBeNull()
    expect(
      lifecycleFocusLaneFor({
        state: "IMPLEMENT",
        status: "WAITING_FOR_WORKER_SLOT",
      }),
    ).toBeNull()
  })

  test("falls back to the latest chip phase when state is non-operational", () => {
    expect(
      lifecycleFocusLaneFor({
        state: "FAILED",
        status: "FAILED",
        lifecycleLabels: [{ phase: "IMPLEMENT" }, { phase: "REVIEW" }],
      }),
    ).toBe("review")
  })
})

describe("earlierLifecycleLanes", () => {
  test("returns earlier lanes in Build → Review → PR order", () => {
    expect(earlierLifecycleLanes("build")).toEqual([])
    expect(earlierLifecycleLanes("review")).toEqual(["build"])
    expect(earlierLifecycleLanes("pr")).toEqual(["build", "review"])
  })
})

describe("sumLaneDurationMs", () => {
  test("sums non-null chip durations and skips nulls", () => {
    expect(
      sumLaneDurationMs([
        { durationMs: 1_000 },
        { durationMs: null },
        { durationMs: 2_500 },
      ]),
    ).toBe(3_500)
  })

  test("returns null when every duration is null", () => {
    expect(
      sumLaneDurationMs([{ durationMs: null }, { durationMs: null }]),
    ).toBeNull()
  })
})

function chip(
  phase: string,
  durationMs: number | null = 1_000,
): LifecycleLabelChip {
  return {
    phase,
    label: `${phase}: Succeeded`,
    status: "SUCCEEDED",
    durationMs,
  }
}

describe("planLifecycleChipPresentation", () => {
  const buildReviewPr: readonly LifecycleLabelChip[] = [
    chip("CREATE_WORKTREE", 10_000),
    chip("IMPLEMENT", 30_000),
    chip("REVIEW", 20_000),
    chip("COMMIT", 5_000),
    chip("CREATE_PR", 8_000),
  ]

  test("PR focus collapses Build and Review as earlier-lane summaries", () => {
    const blocks = planLifecycleChipPresentation(buildReviewPr, {
      collapseEarlierLanes: true,
      focusLane: "pr",
      expandedEarlierLanes: new Set(),
    })
    expect(blocks).toEqual([
      {
        kind: "earlier-lane",
        lane: "build",
        laneLabel: "Build",
        durationMs: 40_000,
        expanded: false,
        chips: [chip("CREATE_WORKTREE", 10_000), chip("IMPLEMENT", 30_000)],
      },
      {
        kind: "earlier-lane",
        lane: "review",
        laneLabel: "Review",
        durationMs: 20_000,
        expanded: false,
        chips: [chip("REVIEW", 20_000)],
      },
      {
        kind: "focus-lane",
        lane: "pr",
        chips: [chip("COMMIT", 5_000), chip("CREATE_PR", 8_000)],
      },
    ])
  })

  test("Review focus collapses Build only; Review chips stay expanded", () => {
    const labels = [chip("IMPLEMENT", 12_000), chip("REVIEW", 9_000)] as const
    const blocks = planLifecycleChipPresentation(labels, {
      collapseEarlierLanes: true,
      focusLane: "review",
      expandedEarlierLanes: new Set(),
    })
    expect(blocks).toEqual([
      {
        kind: "earlier-lane",
        lane: "build",
        laneLabel: "Build",
        durationMs: 12_000,
        expanded: false,
        chips: [chip("IMPLEMENT", 12_000)],
      },
      {
        kind: "focus-lane",
        lane: "review",
        chips: [chip("REVIEW", 9_000)],
      },
    ])
  })

  test("Build focus shows no earlier-lane summaries", () => {
    const labels = [chip("CREATE_WORKTREE"), chip("IMPLEMENT")] as const
    const blocks = planLifecycleChipPresentation(labels, {
      collapseEarlierLanes: true,
      focusLane: "build",
      expandedEarlierLanes: new Set(),
    })
    expect(blocks).toEqual([
      {
        kind: "focus-lane",
        lane: "build",
        chips: [chip("CREATE_WORKTREE"), chip("IMPLEMENT")],
      },
    ])
  })

  test("expanding one earlier lane is independent of the others", () => {
    const collapsed = planLifecycleChipPresentation(buildReviewPr, {
      collapseEarlierLanes: true,
      focusLane: "pr",
      expandedEarlierLanes: new Set(),
    })
    const expandedBuild = planLifecycleChipPresentation(buildReviewPr, {
      collapseEarlierLanes: true,
      focusLane: "pr",
      expandedEarlierLanes: new Set<LifecyclePipelineLaneId>(["build"]),
    })
    expect(
      collapsed
        .filter((block) => block.kind === "earlier-lane")
        .map((block) => [block.lane, block.expanded]),
    ).toEqual([
      ["build", false],
      ["review", false],
    ])
    expect(
      expandedBuild
        .filter((block) => block.kind === "earlier-lane")
        .map((block) => [block.lane, block.expanded]),
    ).toEqual([
      ["build", true],
      ["review", false],
    ])
  })

  test("non-Kanban path keeps the full chip list (no lane summaries)", () => {
    const blocks = planLifecycleChipPresentation(buildReviewPr, {
      collapseEarlierLanes: false,
      focusLane: "pr",
      expandedEarlierLanes: new Set(),
    })
    expect(blocks).toEqual([{ kind: "full-list", chips: buildReviewPr }])
  })

  test("Queue / missing focus keeps the full chip list", () => {
    const blocks = planLifecycleChipPresentation(buildReviewPr, {
      collapseEarlierLanes: true,
      focusLane: null,
      expandedEarlierLanes: new Set(),
    })
    expect(blocks).toEqual([{ kind: "full-list", chips: buildReviewPr }])
  })

  test("summary duration equals the sum of that lane’s chip durations", () => {
    const blocks = planLifecycleChipPresentation(
      [
        chip("CREATE_WORKTREE", 1_000),
        chip("IMPLEMENT", null),
        chip("PRE_COMMIT", 4_000),
        chip("REVIEW", 2_000),
      ],
      {
        collapseEarlierLanes: true,
        focusLane: "review",
        expandedEarlierLanes: new Set(),
      },
    )
    const build = blocks.find(
      (block) => block.kind === "earlier-lane" && block.lane === "build",
    )
    expect(build).toMatchObject({
      kind: "earlier-lane",
      durationMs: 5_000,
    })
    if (build?.kind === "earlier-lane") {
      expect(sumLaneDurationMs(build.chips)).toBe(build.durationMs)
    }
  })

  test("later-than-focus chips stay expanded after focus-lane chips", () => {
    // Defensive: if focus lags retained history, do not drop later steps.
    const labels = [
      chip("IMPLEMENT", 10_000),
      chip("REVIEW", 20_000),
      chip("CREATE_PR", 5_000),
    ] as const
    const blocks = planLifecycleChipPresentation(labels, {
      collapseEarlierLanes: true,
      focusLane: "build",
      expandedEarlierLanes: new Set(),
    })
    expect(blocks).toEqual([
      {
        kind: "focus-lane",
        lane: "build",
        chips: [
          chip("IMPLEMENT", 10_000),
          chip("REVIEW", 20_000),
          chip("CREATE_PR", 5_000),
        ],
      },
    ])
  })

  test("COMPLETE collapse-all condenses Build, Review, and PR (no focus strip)", () => {
    // Repos COMPLETE chrome: PR must not stay a permanent expanded black strip.
    const blocks = planLifecycleChipPresentation(buildReviewPr, {
      collapseEarlierLanes: true,
      focusLane: "pr",
      expandedEarlierLanes: new Set(),
      collapseAllReachedLanes: true,
    })
    expect(blocks).toEqual([
      {
        kind: "earlier-lane",
        lane: "build",
        laneLabel: "Build",
        durationMs: 40_000,
        expanded: false,
        chips: [chip("CREATE_WORKTREE", 10_000), chip("IMPLEMENT", 30_000)],
      },
      {
        kind: "earlier-lane",
        lane: "review",
        laneLabel: "Review",
        durationMs: 20_000,
        expanded: false,
        chips: [chip("REVIEW", 20_000)],
      },
      {
        kind: "earlier-lane",
        lane: "pr",
        laneLabel: "PR",
        durationMs: 13_000,
        expanded: false,
        chips: [chip("COMMIT", 5_000), chip("CREATE_PR", 8_000)],
      },
    ])
    expect(blocks.some((block) => block.kind === "focus-lane")).toBe(false)
  })

  test("COMPLETE collapse-all sums each lane’s chip durations", () => {
    const labels = [
      chip("IMPLEMENT", 12_000),
      chip("PRE_COMMIT", null),
      chip("REVIEW", 9_000),
      chip("COMMIT", 3_000),
      chip("MERGE_PR", 7_000),
      chip("LOCAL_CLEANUP", null),
    ] as const
    const blocks = planLifecycleChipPresentation(labels, {
      collapseEarlierLanes: true,
      focusLane: null,
      expandedEarlierLanes: new Set(),
      collapseAllReachedLanes: true,
    })
    expect(
      blocks
        .filter((block) => block.kind === "earlier-lane")
        .map((block) => [block.lane, block.durationMs]),
    ).toEqual([
      ["build", 12_000],
      ["review", 9_000],
      ["pr", 10_000],
    ])
  })

  test("COMPLETE collapse-all uses forge PR|MR lane label and expand state", () => {
    const collapsed = planLifecycleChipPresentation(buildReviewPr, {
      collapseEarlierLanes: true,
      focusLane: null,
      expandedEarlierLanes: new Set(),
      collapseAllReachedLanes: true,
      prLaneLabel: "MR",
    })
    const prLeg = collapsed.find(
      (block) => block.kind === "earlier-lane" && block.lane === "pr",
    )
    expect(prLeg).toMatchObject({
      kind: "earlier-lane",
      laneLabel: "MR",
      expanded: false,
    })

    const expandedPr = planLifecycleChipPresentation(buildReviewPr, {
      collapseEarlierLanes: true,
      focusLane: null,
      expandedEarlierLanes: new Set<LifecyclePipelineLaneId>(["pr"]),
      collapseAllReachedLanes: true,
      prLaneLabel: "MR",
    })
    expect(
      expandedPr
        .filter((block) => block.kind === "earlier-lane")
        .map((block) => [block.lane, block.expanded]),
    ).toEqual([
      ["build", false],
      ["review", false],
      ["pr", true],
    ])
  })

  test("non-complete focus path still expands current lane only", () => {
    // Regression: collapse-all must not change in-flight PR focus behavior.
    const blocks = planLifecycleChipPresentation(buildReviewPr, {
      collapseEarlierLanes: true,
      focusLane: "pr",
      expandedEarlierLanes: new Set(),
      collapseAllReachedLanes: false,
    })
    expect(blocks.map((block) => block.kind)).toEqual([
      "earlier-lane",
      "earlier-lane",
      "focus-lane",
    ])
    const focus = blocks.find((block) => block.kind === "focus-lane")
    expect(focus).toMatchObject({
      kind: "focus-lane",
      lane: "pr",
      chips: [chip("COMMIT", 5_000), chip("CREATE_PR", 8_000)],
    })
  })
})
