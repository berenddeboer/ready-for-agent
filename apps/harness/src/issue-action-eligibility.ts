import {
  type WorkItemState,
  evaluateActionableIssue,
  evaluateImplementableIssue,
  evaluateUnfinishedWorkItem,
} from "@ready-for-agent/lifecycle-model"

export type GraphqlWorkItemState = Uppercase<WorkItemState>

type IssueActionShape = {
  readonly state: "OPEN" | "CLOSED"
  readonly hasChildren: boolean
  readonly blockedBy: readonly unknown[]
}

type WorkItemActionShape = {
  readonly id: string
  readonly state: GraphqlWorkItemState
  readonly canRetry: boolean
}

const toPredicateWorkItem = (workItem: WorkItemActionShape) => ({
  id: workItem.id,
  state: workItem.state.toLowerCase() as WorkItemState,
  canRetry: workItem.canRetry,
})

export const issueActionEligibility = (input: {
  readonly issue: IssueActionShape
  readonly workItems: readonly WorkItemActionShape[]
  readonly workItemsLoading: boolean
}): {
  readonly canImplement: boolean
  readonly canQueue: boolean
} => {
  if (input.workItemsLoading) {
    return { canImplement: false, canQueue: false }
  }

  const issue = {
    ...input.issue,
    isCurrentIssue: true,
  }
  const workItems = input.workItems.map(toPredicateWorkItem)
  const actionable = evaluateActionableIssue(issue, workItems)
  const implementable = evaluateImplementableIssue(issue)
  const hasUnfinishedWorkItem = workItems.some(
    (workItem) => evaluateUnfinishedWorkItem(workItem)._tag === "match",
  )

  return {
    canImplement: actionable._tag === "match",
    canQueue: implementable._tag === "issue_blocked" && !hasUnfinishedWorkItem,
  }
}
