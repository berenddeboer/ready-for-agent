export type PipelineLaneId =
  | "queue"
  | "build"
  | "review"
  | "pr"
  | "attention"
  | "complete"

export const PIPELINE_LANES = [
  { id: "queue", label: "Queue", color: "#ffd21c", text: "#151515" },
  { id: "build", label: "Build", color: "#1976d2", text: "#ffffff" },
  { id: "review", label: "Review", color: "#7654b5", text: "#ffffff" },
  { id: "pr", label: "PR", color: "#168b62", text: "#ffffff" },
  { id: "attention", label: "Attention", color: "#ff4d1c", text: "#151515" },
  { id: "complete", label: "Complete", color: "#151515", text: "#ffffff" },
] as const satisfies readonly {
  id: PipelineLaneId
  label: string
  color: string
  text: string
}[]

type PipelineWorkItem = {
  readonly state: string
  readonly status: string
}

/**
 * Kanban placement is driven by lifecycle progress, not scheduler status.
 * Attention and Complete override every lane. Queue is only for work that
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

  if (
    workItem.state === "CREATE_WORKTREE" ||
    workItem.state === "INSTALL_DEPENDENCIES" ||
    workItem.state === "IMPLEMENT" ||
    workItem.state === "ASSESS_CHANGES" ||
    workItem.state === "PRE_COMMIT"
  ) {
    return "build"
  }

  if (workItem.state === "REVIEW") {
    return "review"
  }

  if (
    workItem.state === "COMMIT" ||
    workItem.state === "CREATE_PR" ||
    workItem.state === "WATCH_PR_STATUS_CHECKS" ||
    workItem.state === "RESOLVE_PR_MERGE_CONFLICT" ||
    workItem.state === "INVESTIGATE_PR_STATUS_CHECKS" ||
    workItem.state === "MARK_PR_READY_FOR_REVIEW" ||
    workItem.state === "DECIDE_PR_MERGE" ||
    workItem.state === "MERGE_PR" ||
    workItem.state === "CLOSE_ISSUE" ||
    workItem.state === "LOCAL_CLEANUP"
  ) {
    return "pr"
  }

  // Unrecognized non-terminal state: keep off Queue so cards do not oscillate.
  // When the lifecycle gains a step, extend Build, Review, or PR above.
  return "pr"
}
