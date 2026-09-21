import { isIssueTracker } from "./generated/forge.js"
import { persistedIssueIdentity } from "./issue-source.js"
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
  readonly nativeId: string
  readonly displayId: string
  readonly title: string
  readonly url: string
  readonly action: IntakeCandidateAction
}

/** Issue fields required to classify Intake Candidates. */
export type IntakeCandidateIssueInput = {
  readonly issueNumber: number
  readonly issueTracker?: string
  readonly nativeId?: string
  readonly displayId?: string
  readonly title: string
  readonly url: string
  readonly state: string
  readonly hasChildren: boolean
  readonly blockedBy: readonly unknown[]
}

/** Work Item fields required to exclude unfinished Issues. */
export type IntakeCandidateWorkItemInput = WorkItemPredicateShape & {
  readonly issueNumber: number
  readonly issueTracker?: string
  readonly nativeId?: string
}

const intakeIdentityKey = (
  item: {
    readonly issueNumber: number
    readonly issueTracker?: string
    readonly nativeId?: string
  },
  liveTracker: string | null | undefined,
): string => {
  const { nativeId } = persistedIssueIdentity(item)
  const tracker = isIssueTracker(item.issueTracker)
    ? item.issueTracker
    : liveTracker !== undefined &&
        liveTracker !== null &&
        isIssueTracker(liveTracker)
      ? liveTracker
      : ""
  return `${tracker}:${nativeId}`
}

const filterByLiveIssueTracker = <T extends { readonly issueTracker?: string }>(
  items: readonly T[],
  liveTracker: string | null | undefined,
): readonly T[] => {
  if (liveTracker === undefined || liveTracker === null) {
    return items
  }
  if (!isIssueTracker(liveTracker)) {
    return items
  }
  return items.filter((item) => {
    const itemTracker = isIssueTracker(item.issueTracker)
      ? item.issueTracker
      : liveTracker
    return itemTracker === liveTracker
  })
}

/**
 * Pure classifier over a Repository's current Issue projection and Work Items.
 *
 * Returns only ordered Intake Candidates:
 * 1. Actionable Issues as `IMPLEMENT_NOW` (by display identifier)
 * 2. Blocked open leaves with no unfinished Work Item as `QUEUE` (by display identifier)
 *
 * Uses the same leaf / implementable / actionable / unfinished predicates as
 * Implement Now and Queue so candidate listing cannot drift from admission.
 *
 * Before either check, an Issue with a completed Work Item is vetoed
 * outright and never offered, independent of what the Issue's own forge
 * state currently reports. This is a defense-in-depth guard: it must hold
 * even when the forge Issue looks open and startable because its close
 * never landed (see `shippedWorkItems`). Failed and Abandoned history does
 * not trigger this veto; Needs Human remains unfinished and is omitted by
 * the ordinary unfinished-Work-Item rule. The same guard applies for every
 * Forge (GitHub, GitLab, and Azure DevOps).
 */
export const classifyIntakeCandidates = (
  issues: readonly IntakeCandidateIssueInput[],
  workItems: readonly IntakeCandidateWorkItemInput[],
  liveTracker?: string | null,
): readonly IntakeCandidate[] => {
  const scopedIssues = filterByLiveIssueTracker(issues, liveTracker)
  const scopedWorkItems = filterByLiveIssueTracker(workItems, liveTracker)
  const workItemsByIssue = new Map<string, WorkItemPredicateShape[]>()
  for (const workItem of scopedWorkItems) {
    const key = intakeIdentityKey(workItem, liveTracker)
    const existing = workItemsByIssue.get(key)
    if (existing === undefined) {
      workItemsByIssue.set(key, [workItem])
    } else {
      existing.push(workItem)
    }
  }

  const implementNow: IntakeCandidate[] = []
  const queue: IntakeCandidate[] = []

  for (const issue of scopedIssues) {
    const issueWorkItems =
      workItemsByIssue.get(intakeIdentityKey(issue, liveTracker)) ?? []
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
        ...persistedIssueIdentity(issue),
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
      ...persistedIssueIdentity(issue),
      title: issue.title,
      url: issue.url,
      action: "QUEUE",
    })
  }

  const byDisplayId = (left: IntakeCandidate, right: IntakeCandidate) =>
    left.displayId.localeCompare(right.displayId, undefined, { numeric: true })
  implementNow.sort(byDisplayId)
  queue.sort(byDisplayId)
  return [...implementNow, ...queue]
}
