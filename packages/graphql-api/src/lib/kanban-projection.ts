/**
 * Server-owned Kanban projection: lane membership, source windows, and
 * per-lane ordering. Shared by GraphQL `kanbanStatus`, the visual board, and
 * CLI status so lane meaning cannot drift between clients.
 *
 * Lane rules match `docs/kanban.md`. Status and state comparisons are
 * case-insensitive so domain (lowercase) and GraphQL (uppercase) shapes both
 * classify correctly.
 */
import {
  JOBS_COMPLETED_WINDOW_MS,
  type WorkItemState,
  isJobsCompletedWorkItemState,
  isJobsFailedWorkItem,
  isJobsWorkingWorkItem,
} from "@ready-for-agent/work-item-lifecycle"

/** Globally newest terminal failures included in the Kanban source set. */
export const KANBAN_FAILED_LIMIT = 15

const KANBAN_LANE_IDS = [
  "QUEUE",
  "BUILD",
  "REVIEW",
  "PR",
  "ATTENTION",
  "MERGED",
] as const

export type KanbanLaneId = (typeof KANBAN_LANE_IDS)[number]

export type KanbanLaneDefinition = {
  readonly id: KanbanLaneId
  readonly label: string
}

/** Fixed lane order and labels for every Kanban projection response. */
export const KANBAN_LANES = [
  { id: "QUEUE", label: "Queue" },
  { id: "BUILD", label: "Build" },
  { id: "REVIEW", label: "Review" },
  { id: "PR", label: "PR" },
  { id: "ATTENTION", label: "Attention" },
  { id: "MERGED", label: "Merged" },
] as const satisfies readonly KanbanLaneDefinition[]

const BUILD_LIFECYCLE_STATES = new Set([
  "CREATE_WORKTREE",
  "INSTALL_DEPENDENCIES",
  "IMPLEMENT",
  "ASSESS_CHANGES",
  "PRE_COMMIT",
])

const REVIEW_LIFECYCLE_STATES = new Set(["REVIEW"])

const PR_LIFECYCLE_STATES = new Set([
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
])

const normalizeToken = (value: string): string => value.toUpperCase()

/**
 * Classify one Work Item into a Kanban lane from lifecycle state + operator
 * status. Attention and Merged override every lifecycle lane; Queue is only
 * blockers / worker-slot holds; queued later steps stay in Build/Review/PR.
 */
export function kanbanLaneFor(workItem: {
  readonly state: string
  readonly status: string
}): KanbanLaneId {
  const state = normalizeToken(workItem.state)
  const status = normalizeToken(workItem.status)

  if (
    status === "FAILED" ||
    status === "INTERRUPTED" ||
    status === "NEEDS_HUMAN" ||
    status === "NEEDS_HUMAN_REVIEW" ||
    state === "FAILED" ||
    state === "NEEDS_HUMAN"
  ) {
    return "ATTENTION"
  }

  if (
    status === "COMPLETE" ||
    status === "SUCCEEDED" ||
    status === "ABANDONED" ||
    state === "COMPLETE" ||
    state === "ABANDONED"
  ) {
    return "MERGED"
  }

  if (
    status === "WAITING_FOR_BLOCKERS" ||
    status === "WAITING_FOR_WORKER_SLOT"
  ) {
    return "QUEUE"
  }

  if (BUILD_LIFECYCLE_STATES.has(state)) {
    return "BUILD"
  }
  if (REVIEW_LIFECYCLE_STATES.has(state)) {
    return "REVIEW"
  }
  if (PR_LIFECYCLE_STATES.has(state)) {
    return "PR"
  }

  // Unrecognized non-terminal state: keep off Queue so cards do not oscillate.
  return "PR"
}

type SourceMembershipItem = {
  readonly id: string
  readonly state: WorkItemState
  readonly failureCode?: string | null
  readonly createdAt: Date
  readonly stateReadyAt: Date
}

const newestCreatedFirst = <T extends { readonly createdAt: Date }>(
  items: readonly T[],
): T[] =>
  items
    .slice()
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())

const newestStateReadyFirst = <T extends { readonly stateReadyAt: Date }>(
  items: readonly T[],
): T[] =>
  items
    .slice()
    .sort(
      (left, right) =>
        right.stateReadyAt.getTime() - left.stateReadyAt.getTime(),
    )

/**
 * Shared Kanban source set: all working Work Items, the globally newest
 * {@link KANBAN_FAILED_LIMIT} terminal failures, and Complete/Abandoned items
 * with stateReadyAt in the rolling previous 24 hours. Deduplicated by id.
 * Callers apply an optional Repository filter after this set is built.
 */
export function buildKanbanSourceSet<T extends SourceMembershipItem>(
  workItems: readonly T[],
  nowMs: number = Date.now(),
): readonly T[] {
  const working = workItems.filter(isJobsWorkingWorkItem)
  const failed = newestCreatedFirst(
    workItems.filter(isJobsFailedWorkItem),
  ).slice(0, KANBAN_FAILED_LIMIT)
  const windowStartMs = nowMs - JOBS_COMPLETED_WINDOW_MS
  const completed = workItems.filter(
    (item) =>
      isJobsCompletedWorkItemState(item.state) &&
      item.stateReadyAt.getTime() >= windowStartMs,
  )

  const byId = new Map<string, T>()
  for (const item of [...working, ...failed, ...completed]) {
    byId.set(item.id, item)
  }
  return [...byId.values()]
}

export type KanbanProjectableItem = SourceMembershipItem & {
  readonly repositoryId: string
  readonly status: string
}

export type ProjectedKanbanLane<T extends KanbanProjectableItem> = {
  readonly id: KanbanLaneId
  readonly label: string
  readonly count: number
  readonly workItems: readonly T[]
}

/**
 * Assign source-set items to the six fixed lanes, then order:
 * Queue/Build/Review/PR/Attention by createdAt newest-first; Merged by
 * stateReadyAt newest-first.
 */
export function projectKanbanLanes<T extends KanbanProjectableItem>(
  sourceItems: readonly T[],
): readonly ProjectedKanbanLane<T>[] {
  const buckets = new Map<KanbanLaneId, T[]>()
  for (const id of KANBAN_LANE_IDS) {
    buckets.set(id, [])
  }

  for (const item of sourceItems) {
    const lane = kanbanLaneFor({ state: item.state, status: item.status })
    const bucket = buckets.get(lane)
    if (bucket !== undefined) {
      bucket.push(item)
    }
  }

  return KANBAN_LANES.map((lane) => {
    const raw = buckets.get(lane.id) ?? []
    const ordered =
      lane.id === "MERGED"
        ? newestStateReadyFirst(raw)
        : newestCreatedFirst(raw)
    return {
      id: lane.id,
      label: lane.label,
      count: ordered.length,
      workItems: ordered,
    }
  })
}
