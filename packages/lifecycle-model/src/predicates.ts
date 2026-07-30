import {
  type LifecyclePredicateName,
  matchesLifecyclePredicateExpression,
} from "./generated/predicate-expressions.js"
import {
  TERMINAL_WORK_ITEM_STATES,
  type TerminalWorkItemState,
  type WorkItemState,
} from "./generated/work-item-state.js"

export interface IssuePredicateShape {
  readonly isCurrentIssue: boolean
  readonly state: string
  readonly hasChildren: boolean
  readonly blockedBy: readonly unknown[]
}

export interface WorkItemPredicateShape {
  readonly id?: string
  readonly state: WorkItemState
  readonly canRetry: boolean
}

export interface RelevantIssuePredicateShape {
  readonly state: string
  readonly author: string | null
  readonly parent: {
    readonly state: string
    readonly isReadyLabeled: boolean
  } | null
  readonly hasChildren: boolean
  readonly hierarchySupported: boolean
  readonly closingPullRequests: readonly {
    readonly number: number
    readonly repository: string
    readonly state: "OPEN" | "MERGED" | "CLOSED"
    readonly isDraft: boolean
  }[]
}

export interface RelevantIssuePredicateContext {
  readonly forge: string
  readonly repositoryName: string
  readonly workItemPullRequestNumbers: ReadonlySet<number>
  readonly authorScope:
    | { readonly includeAll: true }
    | { readonly includeAll: false; readonly operatorLogin: string }
}

export type LifecyclePredicateFailure =
  | { readonly _tag: "issue_missing" }
  | { readonly _tag: "issue_not_open"; readonly state: string }
  | { readonly _tag: "issue_not_leaf" }
  | { readonly _tag: "issue_blocked"; readonly blockerCount: number }
  | {
      readonly _tag: "unfinished_work_item_exists"
      readonly workItemId: string | null
    }
  | {
      readonly _tag: "work_item_finished"
      readonly state: "complete" | "failed" | "abandoned"
    }
  | { readonly _tag: "issue_hierarchy_unsupported" }
  | {
      readonly _tag: "issue_parent_not_open"
      readonly state: string
    }
  | { readonly _tag: "issue_parent_not_ready" }
  | { readonly _tag: "issue_closing_pull_request_unowned" }
  | { readonly _tag: "issue_author_not_in_scope" }

export interface LifecyclePredicateMatch {
  readonly _tag: "match"
}

export type LifecyclePredicateResult<
  Failure extends LifecyclePredicateFailure = LifecyclePredicateFailure,
> = LifecyclePredicateMatch | Failure

export type LeafIssueFailure =
  | Extract<LifecyclePredicateFailure, { readonly _tag: "issue_missing" }>
  | Extract<LifecyclePredicateFailure, { readonly _tag: "issue_not_leaf" }>

export type ImplementableIssueFailure =
  | LeafIssueFailure
  | Extract<LifecyclePredicateFailure, { readonly _tag: "issue_not_open" }>
  | Extract<LifecyclePredicateFailure, { readonly _tag: "issue_blocked" }>

export type ActionableIssueFailure =
  | ImplementableIssueFailure
  | Extract<
      LifecyclePredicateFailure,
      { readonly _tag: "unfinished_work_item_exists" }
    >

export type UnfinishedWorkItemFailure = Extract<
  LifecyclePredicateFailure,
  { readonly _tag: "work_item_finished" }
>

export type RelevantIssueFailure = Exclude<
  LifecyclePredicateFailure,
  Extract<
    LifecyclePredicateFailure,
    {
      readonly _tag:
        | "issue_not_leaf"
        | "issue_blocked"
        | "unfinished_work_item_exists"
        | "work_item_finished"
    }
  >
>

const MATCH: LifecyclePredicateMatch = { _tag: "match" }

const matchesExpression = (
  name: LifecyclePredicateName,
  classes: readonly string[],
  properties: Readonly<Record<string, string | number | boolean>>,
): boolean =>
  matchesLifecyclePredicateExpression(name, {
    classes: new Set(classes),
    properties,
  })

export const evaluateLeafIssue = (
  issue: Pick<IssuePredicateShape, "hasChildren"> | null | undefined,
): LifecyclePredicateResult<LeafIssueFailure> => {
  if (issue == null) {
    return { _tag: "issue_missing" }
  }
  if (
    matchesExpression("LeafIssue", ["Issue"], {
      hasChildren: issue.hasChildren,
    })
  ) {
    return MATCH
  }
  return { _tag: "issue_not_leaf" }
}

export const evaluateImplementableIssue = (
  issue: IssuePredicateShape | null | undefined,
): LifecyclePredicateResult<ImplementableIssueFailure> => {
  if (issue == null) {
    return { _tag: "issue_missing" }
  }
  if (!issue.isCurrentIssue) {
    return { _tag: "issue_missing" }
  }
  if (
    matchesExpression("ImplementableIssue", ["Issue"], {
      isCurrentIssue: issue.isCurrentIssue,
      isOpenIssue: issue.state === "OPEN",
      hasChildren: issue.hasChildren,
      listedBlockerCount: issue.blockedBy.length,
    })
  ) {
    return MATCH
  }
  if (issue.state !== "OPEN") {
    return { _tag: "issue_not_open", state: issue.state }
  }

  const leaf = evaluateLeafIssue(issue)
  if (leaf._tag !== "match") {
    return leaf
  }

  if (issue.blockedBy.length > 0) {
    return {
      _tag: "issue_blocked",
      blockerCount: issue.blockedBy.length,
    }
  }
  throw new Error("Implementable Issue expression rejected valid facts")
}

export const evaluateUnfinishedWorkItem = (
  workItem: WorkItemPredicateShape,
): LifecyclePredicateResult<UnfinishedWorkItemFailure> => {
  if (
    matchesExpression("UnfinishedWorkItem", ["WorkItem"], {
      currentState: workItem.state,
      canRetry: workItem.canRetry,
    })
  ) {
    return MATCH
  }
  switch (workItem.state) {
    case "complete":
    case "failed":
    case "abandoned":
      return { _tag: "work_item_finished", state: workItem.state }
    default:
      return MATCH
  }
}

export const isTerminalWorkItemState = (
  state: WorkItemState,
): state is TerminalWorkItemState =>
  (TERMINAL_WORK_ITEM_STATES as readonly WorkItemState[]).includes(state)

export const evaluateActionableIssue = (
  issue: IssuePredicateShape | null | undefined,
  workItems: readonly WorkItemPredicateShape[],
): LifecyclePredicateResult<ActionableIssueFailure> => {
  const implementable = evaluateImplementableIssue(issue)
  if (implementable._tag !== "match") {
    return implementable
  }

  const unfinishedWorkItems = workItems.filter(
    (workItem) => evaluateUnfinishedWorkItem(workItem)._tag === "match",
  )
  if (
    issue !== null &&
    issue !== undefined &&
    matchesExpression("ActionableIssue", ["Issue"], {
      isCurrentIssue: issue.isCurrentIssue,
      isOpenIssue: issue.state === "OPEN",
      hasChildren: issue.hasChildren,
      listedBlockerCount: issue.blockedBy.length,
      unfinishedWorkItemCount: unfinishedWorkItems.length,
    })
  ) {
    return MATCH
  }
  const unfinished = unfinishedWorkItems[0]
  if (unfinished !== undefined) {
    return {
      _tag: "unfinished_work_item_exists",
      workItemId: unfinished.id ?? null,
    }
  }
  throw new Error("Actionable Issue expression rejected valid facts")
}

const activeClosingPullRequest = (
  pullRequest: RelevantIssuePredicateShape["closingPullRequests"][number],
  forge: string,
): boolean =>
  pullRequest.state === "MERGED" ||
  (pullRequest.state === "OPEN" && (forge === "gitlab" || !pullRequest.isDraft))

export const evaluateRelevantIssue = (
  issue: RelevantIssuePredicateShape | null | undefined,
  context: RelevantIssuePredicateContext,
): LifecyclePredicateResult<RelevantIssueFailure> => {
  if (issue == null) {
    return { _tag: "issue_missing" }
  }

  let hierarchyFailure: RelevantIssueFailure | undefined
  if (issue.hierarchySupported) {
    if (issue.parent === null) {
      if (issue.state !== "OPEN") {
        hierarchyFailure = { _tag: "issue_not_open", state: issue.state }
      }
    } else {
      if (issue.parent.state !== "OPEN") {
        hierarchyFailure = {
          _tag: "issue_parent_not_open",
          state: issue.parent.state,
        }
      } else if (!issue.parent.isReadyLabeled) {
        hierarchyFailure = { _tag: "issue_parent_not_ready" }
      }
    }
  } else {
    if (context.forge !== "gitlab") {
      hierarchyFailure = { _tag: "issue_hierarchy_unsupported" }
    } else if (issue.state !== "OPEN") {
      hierarchyFailure = { _tag: "issue_not_open", state: issue.state }
    } else if (issue.parent !== null || issue.hasChildren) {
      hierarchyFailure = { _tag: "issue_hierarchy_unsupported" }
    }
  }

  const activeClosingPullRequests = issue.closingPullRequests.filter(
    (pullRequest) => activeClosingPullRequest(pullRequest, context.forge),
  )
  const satisfiesClosingPullRequestCondition =
    activeClosingPullRequests.length === 0 ||
    activeClosingPullRequests.some(
      (pullRequest) =>
        pullRequest.repository.toLowerCase() === context.repositoryName &&
        context.workItemPullRequestNumbers.has(pullRequest.number),
    )
  const isIssueAuthorIncluded =
    context.authorScope.includeAll ||
    (issue.author !== null &&
      issue.author.toLowerCase() ===
        context.authorScope.operatorLogin.toLowerCase())

  if (
    matchesExpression("RelevantIssue", ["ReadyLabeledIssue"], {
      isInSupportedIssueHierarchy: hierarchyFailure === undefined,
      satisfiesClosingPullRequestCondition,
      isIssueAuthorIncluded,
    })
  ) {
    return MATCH
  }
  if (hierarchyFailure !== undefined) {
    return hierarchyFailure
  }
  if (
    activeClosingPullRequests.length > 0 &&
    !satisfiesClosingPullRequestCondition
  ) {
    return { _tag: "issue_closing_pull_request_unowned" }
  }

  if (!isIssueAuthorIncluded) {
    return { _tag: "issue_author_not_in_scope" }
  }

  throw new Error("Relevant Issue expression rejected valid facts")
}
