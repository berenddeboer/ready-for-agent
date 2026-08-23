import {
  type WorkItemPredicateShape,
  evaluateActionableIssue,
  evaluateImplementableIssue,
  evaluateUnfinishedWorkItem,
  shippedWorkItems,
} from "./predicates.js"

/** Intended operator request for one Intake Candidate. */
export type IntakeCandidateAction = "IMPLEMENT_NOW" | "QUEUE"

/**
 * One Issue that Repository Intake would currently send Implement Now or
 * Queue for. Parents, closed/irrelevant Issues, Issues with unfinished Work
 * Items, and Issues with a completed Work Item are never returned.
 */
export type IntakeCandidate = {
  readonly issueNumber: number
  readonly title: string
  readonly url: string
  readonly action: IntakeCandidateAction
}

/** Issue fields required to classify Intake Candidates. */
export type IntakeCandidateIssueInput = {
  readonly issueNumber: number
  readonly title: string
  readonly url: string
  readonly state: string
  readonly hasChildren: boolean
  readonly blockedBy: readonly unknown[]
}

/** Work Item fields required to exclude unfinished Issues. */
export type IntakeCandidateWorkItemInput = WorkItemPredicateShape & {
  readonly issueNumber: number
}

/**
 * Pure classifier over a Repository's current Issue projection and Work Items.
 *
 * Returns only ordered Intake Candidates:
 * 1. Actionable Issues as `IMPLEMENT_NOW` (ascending Issue number)
 * 2. Blocked open leaves with no unfinished Work Item as `QUEUE` (ascending)
 *
 * Uses the same leaf / implementable / actionable / unfinished predicates as
 * Implement Now and Queue so candidate listing cannot drift from admission.
 *
 * Before either check, an Issue with a completed Work Item is vetoed
 * outright and never offered, independent of what the Issue's own forge
 * state currently reports. This is a defense-in-depth guard: it must hold
 * even when the forge Issue looks open and startable because its close
 * never landed (see `shippedWorkItems`).
 */
export const classifyIntakeCandidates = (
  issues: readonly IntakeCandidateIssueInput[],
  workItems: readonly IntakeCandidateWorkItemInput[],
): readonly IntakeCandidate[] => {
  const workItemsByIssue = new Map<number, WorkItemPredicateShape[]>()
  for (const workItem of workItems) {
    const existing = workItemsByIssue.get(workItem.issueNumber)
    if (existing === undefined) {
      workItemsByIssue.set(workItem.issueNumber, [workItem])
    } else {
      existing.push(workItem)
    }
  }

  const implementNow: IntakeCandidate[] = []
  const queue: IntakeCandidate[] = []

  for (const issue of issues) {
    const issueWorkItems = workItemsByIssue.get(issue.issueNumber) ?? []
    if (shippedWorkItems(issueWorkItems).length > 0) {
      continue
    }
    const predicateIssue = {
      isCurrentIssue: true as const,
      state: issue.state,
      hasChildren: issue.hasChildren,
      blockedBy: issue.blockedBy,
    }

    const actionable = evaluateActionableIssue(predicateIssue, issueWorkItems)
    if (actionable._tag === "match") {
      implementNow.push({
        issueNumber: issue.issueNumber,
        title: issue.title,
        url: issue.url,
        action: "IMPLEMENT_NOW",
      })
      continue
    }

    // Queue: open leaf with listed blockers and no unfinished Work Item.
    // evaluateActionableIssue already failed for missing/closed/parent/unfinished.
    const implementable = evaluateImplementableIssue(predicateIssue)
    if (implementable._tag !== "issue_blocked") {
      continue
    }
    const hasUnfinished = issueWorkItems.some(
      (workItem) => evaluateUnfinishedWorkItem(workItem)._tag === "match",
    )
    if (hasUnfinished) {
      continue
    }
    queue.push({
      issueNumber: issue.issueNumber,
      title: issue.title,
      url: issue.url,
      action: "QUEUE",
    })
  }

  implementNow.sort((a, b) => a.issueNumber - b.issueNumber)
  queue.sort((a, b) => a.issueNumber - b.issueNumber)
  return [...implementNow, ...queue]
}
