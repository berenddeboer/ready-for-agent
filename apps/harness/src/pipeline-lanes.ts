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
export const LIFECYCLE_PIPELINE_LANE_ORDER = [
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
export const BUILD_LIFECYCLE_STATES = [
  "CREATE_WORKTREE",
  "INSTALL_DEPENDENCIES",
  "IMPLEMENT",
  "ASSESS_CHANGES",
  "PRE_COMMIT",
] as const

/** Work Item states that place a ticket in Review. */
export const REVIEW_LIFECYCLE_STATES = ["REVIEW"] as const

/**
 * Work Item states that place a ticket in PR (Commit through local cleanup).
 * Chip phase GITHUB_STATUS_CHECKS is the collapsed watch/investigate phase
 * and also maps to PR even though it is not a Work Item state.
 */
export const PR_LIFECYCLE_STATES = [
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

export function lifecycleLaneLabel(lane: LifecyclePipelineLaneId): string {
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
 * Plan Kanban (or full) chip presentation. When collapse is off or focus is
 * unknown, returns a single full-list block. Expanded earlier lanes are those
 * present in `expandedEarlierLanes` (ephemeral UI set).
 */
export function planLifecycleChipPresentation(
  labels: readonly LifecycleLabelChip[],
  options: {
    readonly collapseEarlierLanes: boolean
    readonly focusLane: LifecyclePipelineLaneId | null
    readonly expandedEarlierLanes: ReadonlySet<LifecyclePipelineLaneId>
  },
): readonly LifecycleChipPresentationBlock[] {
  if (
    !options.collapseEarlierLanes ||
    options.focusLane === null ||
    labels.length === 0
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

  const blocks: LifecycleChipPresentationBlock[] = []
  for (const earlier of earlierLifecycleLanes(options.focusLane)) {
    const chips = byLane.get(earlier)
    if (chips === undefined || chips.length === 0) continue
    blocks.push({
      kind: "earlier-lane",
      lane: earlier,
      laneLabel: lifecycleLaneLabel(earlier),
      durationMs: sumLaneDurationMs(chips),
      expanded: options.expandedEarlierLanes.has(earlier),
      chips,
    })
  }

  // Focus-lane chips always expanded. Also surface any later-lane chips (and
  // ungrouped phases) so a focus that lags retained history never drops steps.
  const focusIndex = LIFECYCLE_PIPELINE_LANE_ORDER.indexOf(options.focusLane)
  const laterChips: LifecycleLabelChip[] = []
  for (const lane of LIFECYCLE_PIPELINE_LANE_ORDER.slice(focusIndex + 1)) {
    const chips = byLane.get(lane)
    if (chips !== undefined && chips.length > 0) {
      laterChips.push(...chips)
    }
  }
  const focusChips = [
    ...(byLane.get(options.focusLane) ?? []),
    ...laterChips,
    ...ungrouped,
  ]
  if (focusChips.length > 0 || blocks.length === 0) {
    blocks.push({
      kind: "focus-lane",
      lane: options.focusLane,
      chips: focusChips,
    })
  }

  return blocks
}
