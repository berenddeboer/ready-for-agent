export type PipelineLaneId =
  | "queue"
  | "build"
  | "review"
  | "ship"
  | "attention"
  | "complete"

export const PIPELINE_LANES = [
  { id: "queue", label: "Queue", color: "#ffd21c", text: "#151515" },
  { id: "build", label: "Build", color: "#1976d2", text: "#ffffff" },
  { id: "review", label: "Review", color: "#7654b5", text: "#ffffff" },
  { id: "ship", label: "Ship", color: "#168b62", text: "#ffffff" },
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
    workItem.status === "QUEUED" ||
    workItem.status === "WAITING_FOR_WORKER_SLOT" ||
    workItem.state === "CREATE_WORKTREE" ||
    workItem.state === "INSTALL_DEPENDENCIES"
  ) {
    return "queue"
  }

  if (
    workItem.state === "IMPLEMENT" ||
    workItem.state === "ASSESS_CHANGES" ||
    workItem.state === "PRE_COMMIT"
  ) {
    return "build"
  }

  if (
    workItem.state === "REVIEW" ||
    workItem.state === "WATCH_PR_STATUS_CHECKS" ||
    workItem.state === "RESOLVE_PR_MERGE_CONFLICT" ||
    workItem.state === "INVESTIGATE_PR_STATUS_CHECKS"
  ) {
    return "review"
  }

  return "ship"
}
