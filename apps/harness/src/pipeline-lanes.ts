export type PipelineLaneId =
  | "queue"
  | "build"
  | "review"
  | "pr"
  | "attention"
  | "complete"

/** Lifecycle lanes that host step chips (Build → Review → PR order). */
export type LifecyclePipelineLaneId = "build" | "review" | "pr"

export const PIPELINE_LANES = [
  { id: "queue", label: "Queue", color: "#ffd21c", text: "#151515" },
  { id: "build", label: "Build", color: "#1976d2", text: "#ffffff" },
  { id: "review", label: "Review", color: "#7654b5", text: "#ffffff" },
  { id: "pr", label: "PR", color: "#168b62", text: "#ffffff" },
  { id: "attention", label: "Attention", color: "#ff4d1c", text: "#151515" },
  { id: "complete", label: "Merged", color: "#151515", text: "#ffffff" },
] as const satisfies readonly {
  id: PipelineLaneId
  label: string
  color: string
  text: string
}[]

/** Ordered lifecycle lanes used for earlier-lane chip collapse. */
const LIFECYCLE_PIPELINE_LANE_ORDER = [
  "build",
  "review",
  "pr",
] as const satisfies readonly LifecyclePipelineLaneId[]

const LIFECYCLE_LANE_LABEL: Record<LifecyclePipelineLaneId, string> = {
  build: "Build",
  review: "Review",
  pr: "PR",
}

/**
 * Work Item states that place a ticket in Build. Shared with chip phase
 * grouping so board placement and Kanban chip collapse stay aligned.
 */
const BUILD_LIFECYCLE_STATES = [
  "CREATE_WORKTREE",
  "INSTALL_DEPENDENCIES",
  "IMPLEMENT",
  "ASSESS_CHANGES",
  "PRE_COMMIT",
] as const

/** Work Item states that place a ticket in Review. */
const REVIEW_LIFECYCLE_STATES = ["REVIEW"] as const

/**
 * Work Item states that place a ticket in PR (Commit through local cleanup).
 * Chip phase GITHUB_STATUS_CHECKS is the collapsed watch/investigate phase
 * and also maps to PR even though it is not a Work Item state.
 */
const PR_LIFECYCLE_STATES = [
  "COMMIT",
  "CREATE_PR",
  "WATCH_PR_STATUS_CHECKS",
  "RESOLVE_PR_MERGE_CONFLICT",
  "INVESTIGATE_PR_STATUS_CHECKS",
  "MARK_PR_READY_FOR_REVIEW",
  "DECIDE_PR_MERGE",
  "MERGE_PR",
  "CLOSE_ISSUE",
  "LOCAL_CLEANUP",
] as const

const BUILD_PHASES = new Set<string>(BUILD_LIFECYCLE_STATES)
const REVIEW_PHASES = new Set<string>(REVIEW_LIFECYCLE_STATES)
const PR_PHASES = new Set<string>([
  ...PR_LIFECYCLE_STATES,
  // Collapsed GitHub status-checks phase from lifecycleLabels projection.
  "GITHUB_STATUS_CHECKS",
])

type PipelineWorkItem = {
  readonly state: string
  readonly status: string
}

/**
 * Kanban placement is driven by lifecycle progress, not scheduler status.
 * Attention and Merged override every lane. Queue is only for work that
 * cannot begin yet (blockers or worker slot). Queued step execution stays in
 * its lifecycle lane (Build / Review / PR).
 */
export function pipelineLaneFor(workItem: PipelineWorkItem): PipelineLaneId {
  if (
    workItem.status === "FAILED" ||
    workItem.status === "INTERRUPTED" ||
    workItem.status === "NEEDS_HUMAN" ||
    workItem.status === "NEEDS_HUMAN_REVIEW" ||
    workItem.state === "FAILED" ||
    workItem.state === "NEEDS_HUMAN"
  ) {
    return "attention"
  }

  if (
    workItem.status === "COMPLETE" ||
    workItem.status === "SUCCEEDED" ||
    workItem.status === "ABANDONED" ||
    workItem.state === "COMPLETE" ||
    workItem.state === "ABANDONED"
  ) {
    return "complete"
  }

  if (
    workItem.status === "WAITING_FOR_BLOCKERS" ||
    workItem.status === "WAITING_FOR_WORKER_SLOT"
  ) {
    return "queue"
  }

  const lifecycleLane = lifecycleLaneForState(workItem.state)
  if (lifecycleLane !== null) {
    return lifecycleLane
  }

  // Unrecognized non-terminal state: keep off Queue so cards do not oscillate.
  // When the lifecycle gains a step, extend Build, Review, or PR above.
  return "pr"
}

/** Map a Work Item operational state to its lifecycle lane (ignores status). */
export function lifecycleLaneForState(
  state: string,
): LifecyclePipelineLaneId | null {
  if ((BUILD_LIFECYCLE_STATES as readonly string[]).includes(state)) {
    return "build"
  }
  if ((REVIEW_LIFECYCLE_STATES as readonly string[]).includes(state)) {
    return "review"
  }
  if ((PR_LIFECYCLE_STATES as readonly string[]).includes(state)) {
    return "pr"
  }
  return null
}

/**
 * Map a lifecycle chip phase to Build / Review / PR. Matches board placement
 * phase sets; GITHUB_STATUS_CHECKS counts as PR.
 */
export function lifecycleLaneForPhase(
  phase: string,
): LifecyclePipelineLaneId | null {
  if (BUILD_PHASES.has(phase)) return "build"
  if (REVIEW_PHASES.has(phase)) return "review"
  if (PR_PHASES.has(phase)) return "pr"
  return null
}

function lifecycleLaneLabel(lane: LifecyclePipelineLaneId): string {
  return LIFECYCLE_LANE_LABEL[lane]
}

/**
 * Chip focus lane for Kanban collapse. Uses lifecycle progress from state
 * alone so Attention tickets still expand the Build/Review/PR path they are
 * on. Queue hold statuses do not collapse (chips are usually absent).
 */
export function lifecycleFocusLaneFor(workItem: {
  readonly state: string
  readonly status: string
  readonly lifecycleLabels?: readonly { readonly phase: string }[]
}): LifecyclePipelineLaneId | null {
  if (
    workItem.status === "WAITING_FOR_BLOCKERS" ||
    workItem.status === "WAITING_FOR_WORKER_SLOT"
  ) {
    return null
  }

  const fromState = lifecycleLaneForState(workItem.state)
  if (fromState !== null) {
    return fromState
  }

  // Terminal / attention state values (FAILED, NEEDS_HUMAN, COMPLETE, …):
  // fall back to the latest chip phase so earlier lanes can still collapse.
  const labels = workItem.lifecycleLabels
  if (labels === undefined || labels.length === 0) {
    return null
  }
  for (let index = labels.length - 1; index >= 0; index -= 1) {
    const label = labels[index]
    if (label === undefined) continue
    const lane = lifecycleLaneForPhase(label.phase)
    if (lane !== null) {
      return lane
    }
  }
  return null
}

/** Lifecycle lanes strictly earlier than focus, in Build → Review → PR order. */
export function earlierLifecycleLanes(
  focusLane: LifecyclePipelineLaneId,
): readonly LifecyclePipelineLaneId[] {
  const focusIndex = LIFECYCLE_PIPELINE_LANE_ORDER.indexOf(focusLane)
  if (focusIndex <= 0) {
    return []
  }
  return LIFECYCLE_PIPELINE_LANE_ORDER.slice(0, focusIndex)
}

export type LifecycleLabelChip = {
  readonly phase: string
  readonly label: string
  readonly status: string
  readonly durationMs: number | null
}

/**
 * Sum chip durations for a lane summary. Null durations are omitted; returns
 * null when every chip has a null duration (no sum to display).
 */
export function sumLaneDurationMs(
  chips: readonly Pick<LifecycleLabelChip, "durationMs">[],
): number | null {
  let total = 0
  let hasDuration = false
  for (const chip of chips) {
    if (chip.durationMs === null) continue
    hasDuration = true
    total += chip.durationMs
  }
  return hasDuration ? total : null
}

export type LifecycleChipPresentationBlock =
  | {
      readonly kind: "earlier-lane"
      readonly lane: LifecyclePipelineLaneId
      readonly laneLabel: string
      readonly durationMs: number | null
      readonly expanded: boolean
      readonly chips: readonly LifecycleLabelChip[]
    }
  | {
      readonly kind: "focus-lane"
      readonly lane: LifecyclePipelineLaneId | null
      readonly chips: readonly LifecycleLabelChip[]
    }
  | {
      readonly kind: "full-list"
      readonly chips: readonly LifecycleLabelChip[]
    }

/**
 * Plan Kanban / repos chip presentation. When collapse is off or focus is
 * unknown (and not collapse-all), returns a single full-list block.
 *
 * Modes when `collapseEarlierLanes` is on:
 * - **Focus lane** (default): earlier Build/Review/PR lanes collapse into
 *   expandable summaries; the focus lane stays a full chip list.
 * - **All reached** (`collapseAllReachedLanes`): every reached lifecycle lane
 *   collapses — used for terminal COMPLETE repos chrome so PR is not left as
 *   a permanent expanded strip (`docs/harness-design-system.md` §4.6).
 *
 * Expanded collapsed lanes are those present in `expandedEarlierLanes`
 * (ephemeral UI set). Optional `prLaneLabel` overrides the PR-lane summary
 * text (e.g. "MR" on GitLab).
 */
export function planLifecycleChipPresentation(
  labels: readonly LifecycleLabelChip[],
  options: {
    readonly collapseEarlierLanes: boolean
    readonly focusLane: LifecyclePipelineLaneId | null
    readonly expandedEarlierLanes: ReadonlySet<LifecyclePipelineLaneId>
    /**
     * Collapse every reached lifecycle lane (BUILD / REVIEW / PR|MR) as
     * expandable journey-style summaries. Used for terminal COMPLETE work
     * items under repos chrome. When true, `focusLane` is ignored.
     */
    readonly collapseAllReachedLanes?: boolean
    /** Label for the PR lifecycle lane summary (default "PR"; use "MR" on GitLab). */
    readonly prLaneLabel?: string
  },
): readonly LifecycleChipPresentationBlock[] {
  const collapseAll = options.collapseAllReachedLanes === true
  if (
    !options.collapseEarlierLanes ||
    labels.length === 0 ||
    (!collapseAll && options.focusLane === null)
  ) {
    return [{ kind: "full-list", chips: labels }]
  }

  const byLane = new Map<LifecyclePipelineLaneId, LifecycleLabelChip[]>()
  const ungrouped: LifecycleLabelChip[] = []
  for (const label of labels) {
    const lane = lifecycleLaneForPhase(label.phase)
    if (lane === null) {
      ungrouped.push(label)
      continue
    }
    const existing = byLane.get(lane)
    if (existing === undefined) {
      byLane.set(lane, [label])
    } else {
      existing.push(label)
    }
  }

  const laneSummaryLabel = (lane: LifecyclePipelineLaneId): string => {
    if (lane === "pr" && options.prLaneLabel !== undefined) {
      return options.prLaneLabel
    }
    return lifecycleLaneLabel(lane)
  }

  const collapsedLaneBlock = (
    lane: LifecyclePipelineLaneId,
    chips: readonly LifecycleLabelChip[],
  ): LifecycleChipPresentationBlock => ({
    kind: "earlier-lane",
    lane,
    laneLabel: laneSummaryLabel(lane),
    durationMs: sumLaneDurationMs(chips),
    expanded: options.expandedEarlierLanes.has(lane),
    chips,
  })

  // COMPLETE journey: every reached lane is a condensed expandable leg.
  if (collapseAll) {
    const blocks: LifecycleChipPresentationBlock[] = []
    for (const lane of LIFECYCLE_PIPELINE_LANE_ORDER) {
      const chips = byLane.get(lane)
      if (chips === undefined || chips.length === 0) continue
      blocks.push(collapsedLaneBlock(lane, chips))
    }
    if (ungrouped.length > 0) {
      blocks.push({ kind: "focus-lane", lane: null, chips: ungrouped })
    }
    if (blocks.length === 0) {
      return [{ kind: "full-list", chips: labels }]
    }
    return blocks
  }

  const focusLane = options.focusLane
  if (focusLane === null) {
    return [{ kind: "full-list", chips: labels }]
  }

  const blocks: LifecycleChipPresentationBlock[] = []
  for (const earlier of earlierLifecycleLanes(focusLane)) {
    const chips = byLane.get(earlier)
    if (chips === undefined || chips.length === 0) continue
    blocks.push(collapsedLaneBlock(earlier, chips))
  }

  // Focus-lane chips always expanded. Also surface any later-lane chips (and
  // ungrouped phases) so a focus that lags retained history never drops steps.
  const focusIndex = LIFECYCLE_PIPELINE_LANE_ORDER.indexOf(focusLane)
  const laterChips: LifecycleLabelChip[] = []
  for (const lane of LIFECYCLE_PIPELINE_LANE_ORDER.slice(focusIndex + 1)) {
    const chips = byLane.get(lane)
    if (chips !== undefined && chips.length > 0) {
      laterChips.push(...chips)
    }
  }
  const focusChips = [
    ...(byLane.get(focusLane) ?? []),
    ...laterChips,
    ...ungrouped,
  ]
  if (focusChips.length > 0 || blocks.length === 0) {
    blocks.push({
      kind: "focus-lane",
      lane: focusLane,
      chips: focusChips,
    })
  }

  return blocks
}
