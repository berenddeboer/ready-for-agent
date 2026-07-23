import type { IssueRecord } from "@ready-for-agent/db-service"
import {
  type OperationalLifecycleStep,
  REVIEW_APPLYING_FINDINGS_MESSAGE,
  REVIEW_REVIEWING_MESSAGE,
  STEP_RUN_REASON,
  type StepRunRecord,
  type WorkItemRecord,
  isTerminalWorkItemState,
} from "@ready-for-agent/work-item-lifecycle"

const childIssueCategory = (issue: IssueRecord): number => {
  if (issue.state === "CLOSED") return 2
  return issue.blockedBy.length === 0 ? 0 : 1
}

const compareChildIssues = (left: IssueRecord, right: IssueRecord): number =>
  childIssueCategory(left) - childIssueCategory(right) ||
  (left.parentPosition ?? Number.MAX_SAFE_INTEGER) -
    (right.parentPosition ?? Number.MAX_SAFE_INTEGER) ||
  left.githubIssueNumber - right.githubIssueNumber

export const workIssueProjection = (
  issues: readonly IssueRecord[],
): readonly IssueRecord[] => {
  const childrenByParent = new Map<number, IssueRecord[]>()
  for (const issue of issues) {
    if (issue.parent === null) continue
    const children = childrenByParent.get(issue.parent.githubIssueNumber) ?? []
    children.push(issue)
    childrenByParent.set(issue.parent.githubIssueNumber, children)
  }

  return issues
    .filter((issue) => issue.parent === null)
    .sort((left, right) => right.githubIssueNumber - left.githubIssueNumber)
    .flatMap((issue) => {
      if (!issue.hasChildren) return [issue]
      const children = childrenByParent.get(issue.githubIssueNumber) ?? []
      if (children.length === 0) return []
      return [issue, ...children.sort(compareChildIssues)]
    })
}

export type WorkItemStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "complete"
  | "abandoned"
  | "needs_human"
  | "needs_human_review"
  | "waiting_for_worker_slot"

type LifecyclePhase =
  | Exclude<
      OperationalLifecycleStep,
      "watch_pr_status_checks" | "investigate_pr_status_checks"
    >
  | "github_status_checks"

const lifecyclePhase = (step: OperationalLifecycleStep): LifecyclePhase => {
  if (
    step === "watch_pr_status_checks" ||
    step === "investigate_pr_status_checks"
  ) {
    return "github_status_checks"
  }
  return step
}

const lifecyclePhaseLabel = (phase: LifecyclePhase): string => {
  switch (phase) {
    case "implement":
      return "Build"
    case "assess_changes":
      return "Assess changes"
    case "close_issue":
      return "Close issue"
    case "resolve_pr_merge_conflict":
      return "Resolve PR merge conflict"
    case "github_status_checks":
      return "GitHub status checks"
    case "mark_pr_ready_for_review":
      return "Mark PR ready for review"
    case "decide_pr_merge":
      return "Decide PR merge"
    case "merge_pr":
      return "Merge PR"
    default:
      return phase
        .replaceAll("_", " ")
        .replace(/^./, (first) => first.toUpperCase())
  }
}

export const statusLabel = (status: WorkItemStatus): string =>
  status.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase())

export const latestStepRun = (
  workItem: WorkItemRecord,
): StepRunRecord | undefined => workItem.stepRuns.at(-1)

/** Running Step Run blocked on maxConcurrentOpencodeSessions → operator Queued. */
const isWaitingForOpencodeSession = (stepRun: StepRunRecord): boolean =>
  stepRun.status === "running" &&
  stepRun.reasonCode === STEP_RUN_REASON.waitingForOpencodeSession

const stepRunDisplayStatus = (stepRun: StepRunRecord): WorkItemStatus =>
  isWaitingForOpencodeSession(stepRun) ? "queued" : stepRun.status

export const workItemStatus = (workItem: WorkItemRecord): WorkItemStatus => {
  if (workItem.waitingSince != null) return "waiting_for_worker_slot"
  if (isTerminalWorkItemState(workItem.state)) return workItem.state
  if (workItem.paused) return "needs_human_review"
  const latest = latestStepRun(workItem)
  if (latest === undefined) return "queued"
  return stepRunDisplayStatus(latest)
}

export const lifecycleLabels = (workItem: WorkItemRecord) => {
  const latestRuns = new Map<LifecyclePhase, StepRunRecord>()
  for (const stepRun of workItem.stepRuns) {
    latestRuns.set(lifecyclePhase(stepRun.step), stepRun)
  }
  const finalStepRun = latestStepRun(workItem)
  const finalPhase =
    workItem.state === "needs_human" && finalStepRun !== undefined
      ? lifecyclePhase(finalStepRun.step)
      : null

  return [...latestRuns].map(([phase, stepRun]) => {
    const status: WorkItemStatus =
      phase === finalPhase ? "needs_human" : stepRunDisplayStatus(stepRun)
    const reviewRunningPhase =
      phase === "review" && status === "running"
        ? stepRun.reasonCode === STEP_RUN_REASON.reviewApplyingFindings ||
          stepRun.reasonMessage === REVIEW_APPLYING_FINDINGS_MESSAGE
          ? REVIEW_APPLYING_FINDINGS_MESSAGE
          : stepRun.reasonCode === STEP_RUN_REASON.reviewReviewing ||
              stepRun.reasonMessage == null ||
              stepRun.reasonMessage === "" ||
              stepRun.reasonMessage === REVIEW_REVIEWING_MESSAGE
            ? REVIEW_REVIEWING_MESSAGE
            : stepRun.reasonMessage
        : null
    const outcome =
      reviewRunningPhase !== null
        ? reviewRunningPhase
        : phase === "decide_pr_merge" && status === "needs_human"
          ? "Human review before merge"
          : phase === "decide_pr_merge" && status === "succeeded"
            ? "Clanker may merge"
            : phase === "merge_pr" &&
                status === "succeeded" &&
                stepRun.reasonCode !== STEP_RUN_REASON.mergeRevalidation
              ? "Merged"
              : statusLabel(status)
    return {
      phase: phase.toUpperCase(),
      label: `${lifecyclePhaseLabel(phase)}: ${outcome}`,
      status: status.toUpperCase(),
      durationMs: stepRun.executionDurationMs,
    }
  })
}

export const workItemStateLabel = (workItem: WorkItemRecord): string => {
  if (isTerminalWorkItemState(workItem.state)) {
    return statusLabel(workItem.state)
  }
  return lifecyclePhaseLabel(lifecyclePhase(workItem.state))
}
