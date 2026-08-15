import type { IssueRecord } from "@ready-for-agent/db-service"
import {
  type StepRunReasonDetail,
  parseReasonDetail,
} from "@ready-for-agent/github-service"
import {
  LIFECYCLE_STEP_RETRYABLE,
  type OperationalLifecycleStep,
  type TerminalWorkItemState,
  isTerminalWorkItemState,
} from "@ready-for-agent/lifecycle-model"
import {
  REVIEW_APPLYING_FINDINGS_MESSAGE,
  REVIEW_ASSESSING_RERUN_MESSAGE,
  REVIEW_PRE_COMMIT_MESSAGE,
  REVIEW_REVIEWING_MESSAGE,
  STEP_RUN_REASON,
  type StepRunRecord,
  WAITING_FOR_WORKER_SLOT_MESSAGE,
  type WorkItemRecord,
  formatWaitingForBlockersMessage,
  isRetryableFailedWorkItem,
  isRetryableNeedsHumanWorkItem,
} from "@ready-for-agent/work-item-lifecycle"

const childIssueCategory = (issue: IssueRecord): number => {
  if (issue.state === "CLOSED") return 2
  return issue.blockedBy.length === 0 ? 0 : 1
}

const compareChildIssues = (left: IssueRecord, right: IssueRecord): number =>
  childIssueCategory(left) - childIssueCategory(right) ||
  (left.parentPosition ?? Number.MAX_SAFE_INTEGER) -
    (right.parentPosition ?? Number.MAX_SAFE_INTEGER) ||
  left.issueNumber - right.issueNumber

export const workIssueProjection = (
  issues: readonly IssueRecord[],
): readonly IssueRecord[] => {
  const childrenByParent = new Map<number, IssueRecord[]>()
  for (const issue of issues) {
    if (issue.parent === null) continue
    const children = childrenByParent.get(issue.parent.issueNumber) ?? []
    children.push(issue)
    childrenByParent.set(issue.parent.issueNumber, children)
  }

  return issues
    .filter((issue) => issue.parent === null)
    .sort((left, right) => right.issueNumber - left.issueNumber)
    .flatMap((issue) => {
      if (!issue.hasChildren) return [issue]
      const children = childrenByParent.get(issue.issueNumber) ?? []
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
  | "postponed"
  | "complete"
  | "abandoned"
  | "needs_human"
  | "needs_human_review"
  | "waiting_for_worker_slot"
  | "waiting_for_blockers"
  | "waiting_for_github"

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
      // Forge-neutral: same Watch phase for GitHub checks and GitLab pipeline jobs.
      return "Status checks"
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
  status === "waiting_for_github"
    ? "Waiting for GitHub"
    : status.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase())

const latestStepRun = (workItem: WorkItemRecord): StepRunRecord | undefined =>
  workItem.stepRuns.at(-1)

/** Running Step Run blocked on maxConcurrentAgentTurns → operator Queued. */
const isWaitingForAgentTurn = (stepRun: StepRunRecord): boolean =>
  stepRun.status === "running" &&
  (stepRun.reasonCode === STEP_RUN_REASON.waitingForAgentTurn ||
    stepRun.reasonCode === "waiting_for_opencode_session")

const stepRunDisplayStatus = (stepRun: StepRunRecord): WorkItemStatus =>
  isWaitingForAgentTurn(stepRun) ? "queued" : stepRun.status

export const workItemIsTerminal = (
  workItem: WorkItemRecord,
): workItem is WorkItemRecord & { readonly state: TerminalWorkItemState } =>
  isTerminalWorkItemState(workItem.state)

const hasActiveStepRunBeforeLatest = (workItem: WorkItemRecord): boolean =>
  workItem.stepRuns
    .slice(0, -1)
    .some(
      (stepRun) => stepRun.status === "queued" || stepRun.status === "running",
    )

/** Holds that always take precedence over a derived GitHub wait. */
const higherPriorityWorkItemStatus = (
  workItem: WorkItemRecord,
): WorkItemStatus | null => {
  if (workItemIsTerminal(workItem)) return workItem.state
  if (workItem.waitingForBlockers) return "waiting_for_blockers"
  if (workItem.waitingSince !== null) return "waiting_for_worker_slot"
  if (workItem.paused) return "needs_human_review"
  return null
}

/**
 * The authoritative retry deadline is visible only while the Postponed Step
 * Run forms the current GitHub hold. Higher-precedence holds and impossible
 * active-resource combinations must not leak a stale wake deadline.
 */
export const workItemPostponedUntil = (
  workItem: WorkItemRecord,
): Date | null => {
  if (
    higherPriorityWorkItemStatus(workItem) !== null ||
    workItem.holdsWorkerSlot ||
    hasActiveStepRunBeforeLatest(workItem)
  ) {
    return null
  }
  const latest = latestStepRun(workItem)
  return latest?.status === "postponed" ? latest.postponedUntil : null
}

export const workItemCanRetry = (workItem: WorkItemRecord): boolean => {
  if (
    workItem.waitingSince != null ||
    workItem.waitingForBlockers ||
    workItem.paused
  ) {
    return false
  }

  if (
    isRetryableFailedWorkItem(workItem) ||
    isRetryableNeedsHumanWorkItem(workItem)
  ) {
    return true
  }

  if (
    isTerminalWorkItemState(workItem.state) ||
    !Object.hasOwn(LIFECYCLE_STEP_RETRYABLE, workItem.state) ||
    !LIFECYCLE_STEP_RETRYABLE[workItem.state as OperationalLifecycleStep]
  ) {
    return false
  }

  const latestStatus = latestStepRun(workItem)?.status
  return latestStatus === "failed" || latestStatus === "interrupted"
}

export const workItemStatus = (workItem: WorkItemRecord): WorkItemStatus => {
  const higherPriorityStatus = higherPriorityWorkItemStatus(workItem)
  if (higherPriorityStatus !== null) return higherPriorityStatus
  if (workItemPostponedUntil(workItem) !== null) return "waiting_for_github"
  const latest = latestStepRun(workItem)
  if (latest === undefined) return "queued"
  return stepRunDisplayStatus(latest)
}

const REVIEW_IN_PROGRESS_CHIP_MESSAGES = new Set<string>([
  REVIEW_REVIEWING_MESSAGE,
  REVIEW_APPLYING_FINDINGS_MESSAGE,
  REVIEW_PRE_COMMIT_MESSAGE,
  REVIEW_ASSESSING_RERUN_MESSAGE,
])

const isRedundantReviewInProgressMessage = (stepRun: StepRunRecord): boolean =>
  stepRun.status === "running" &&
  stepRun.step === "review" &&
  stepRun.reasonMessage != null &&
  REVIEW_IN_PROGRESS_CHIP_MESSAGES.has(stepRun.reasonMessage)

export const workItemStatusMessage = (
  workItem: WorkItemRecord,
  options?: {
    readonly blockerIssueNumbers?: readonly number[]
  },
): string | null => {
  if (workItemIsTerminal(workItem)) {
    return workItem.failureMessage
  }
  if (workItem.waitingForBlockers) {
    return formatWaitingForBlockersMessage(options?.blockerIssueNumbers ?? [])
  }
  if (workItem.waitingSince != null) {
    return WAITING_FOR_WORKER_SLOT_MESSAGE
  }
  if (workItem.paused) {
    return workItem.failureMessage
  }
  const postponedUntil = workItemPostponedUntil(workItem)
  if (postponedUntil !== null) {
    return `Waiting for GitHub until ${postponedUntil.toISOString()}`
  }
  if (workItem.failureMessage != null) {
    return workItem.failureMessage
  }
  const latest = latestStepRun(workItem)
  if (latest === undefined || latest.reasonMessage == null) {
    return null
  }
  if (isRedundantReviewInProgressMessage(latest)) {
    return null
  }
  return latest.reasonMessage
}

/**
 * Parsed `reason_detail` from the latest Step Run. Null when that run has no
 * persisted cause chain. Messages are re-sanitized on parse.
 */
export const workItemLatestStepRunDetail = (
  workItem: WorkItemRecord,
): StepRunReasonDetail | null =>
  parseReasonDetail(latestStepRun(workItem)?.reasonDetail)

/**
 * Persisted latest Step Run reason for operators. Null when the Work Item
 * has no Step Run yet. `detail` is null when no sanitized cause chain exists.
 */
export type WorkItemLatestStepRunReason = {
  readonly code: string | null
  readonly message: string | null
  readonly detail: StepRunReasonDetail | null
}

export const workItemLatestStepRunReason = (
  workItem: WorkItemRecord,
): WorkItemLatestStepRunReason | null => {
  const latest = latestStepRun(workItem)
  if (latest === undefined) {
    return null
  }
  return {
    code: latest.reasonCode,
    message: latest.reasonMessage,
    detail: parseReasonDetail(latest.reasonDetail),
  }
}

/**
 * Cumulative wall-clock execution time for a phase across every attempt in
 * the same Work Item. Prior failed, timed-out, and Needs Human attempts stay
 * included so retries and continues do not reset the displayed timer.
 * Null when no attempt has started yet (first attempt still queued).
 */
export const cumulativeExecutionDurationMs = (
  stepRuns: readonly Pick<StepRunRecord, "executionDurationMs">[],
): number | null => {
  let total = 0
  let hasStartedAttempt = false
  for (const stepRun of stepRuns) {
    if (stepRun.executionDurationMs === null) continue
    hasStartedAttempt = true
    total += stepRun.executionDurationMs
  }
  return hasStartedAttempt ? total : null
}

export const lifecycleLabels = (workItem: WorkItemRecord) => {
  const latestRuns = new Map<LifecyclePhase, StepRunRecord>()
  const runsByPhase = new Map<LifecyclePhase, StepRunRecord[]>()
  for (const stepRun of workItem.stepRuns) {
    const phase = lifecyclePhase(stepRun.step)
    latestRuns.set(phase, stepRun)
    const runs = runsByPhase.get(phase)
    if (runs === undefined) {
      runsByPhase.set(phase, [stepRun])
    } else {
      runs.push(stepRun)
    }
  }
  const finalStepRun = latestStepRun(workItem)
  const finalPhase =
    workItem.state === "needs_human" && finalStepRun !== undefined
      ? lifecyclePhase(finalStepRun.step)
      : null

  return [...latestRuns].flatMap(([phase, stepRun]) => {
    const status: WorkItemStatus =
      phase === finalPhase ? "needs_human" : stepRunDisplayStatus(stepRun)
    const reviewRunningPhase =
      phase === "review" && status === "running"
        ? stepRun.reasonCode === STEP_RUN_REASON.reviewApplyingFindings ||
          stepRun.reasonMessage === REVIEW_APPLYING_FINDINGS_MESSAGE
          ? REVIEW_APPLYING_FINDINGS_MESSAGE
          : stepRun.reasonCode === STEP_RUN_REASON.reviewPreCommit ||
              stepRun.reasonMessage === REVIEW_PRE_COMMIT_MESSAGE
            ? REVIEW_PRE_COMMIT_MESSAGE
            : stepRun.reasonCode === STEP_RUN_REASON.reviewAssessingRerun ||
                stepRun.reasonMessage === REVIEW_ASSESSING_RERUN_MESSAGE
              ? REVIEW_ASSESSING_RERUN_MESSAGE
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
    const latestLabel = {
      phase: phase.toUpperCase(),
      label: `${lifecyclePhaseLabel(phase)}: ${outcome}`,
      status: status.toUpperCase(),
      durationMs: cumulativeExecutionDurationMs(runsByPhase.get(phase) ?? []),
    }
    const priorPostponedCount = (runsByPhase.get(phase) ?? [])
      .slice(0, -1)
      .filter((run) => run.status === "postponed").length
    if (priorPostponedCount === 0) return [latestLabel]

    const attemptLabel = priorPostponedCount === 1 ? "attempt" : "attempts"
    return [
      {
        phase: phase.toUpperCase(),
        label: `${lifecyclePhaseLabel(phase)}: Postponed (${priorPostponedCount} prior ${attemptLabel})`,
        status: "POSTPONED",
        durationMs: null,
      },
      latestLabel,
    ]
  })
}

export const workItemStateLabel = (workItem: WorkItemRecord): string => {
  if (workItemIsTerminal(workItem)) {
    return statusLabel(workItem.state)
  }
  return lifecyclePhaseLabel(
    lifecyclePhase(workItem.state as OperationalLifecycleStep),
  )
}
