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
  readonly closingPullRequests: readonly ClosingPullRequestPredicateShape[]
}

export interface ClosingPullRequestPredicateShape {
  readonly number: number
  readonly repository: string
  readonly state: "OPEN" | "MERGED" | "CLOSED"
  readonly isDraft: boolean
  readonly sourceBranch?: string | null
  readonly sourceRepository?: string | null
}

export interface PendingSelfOwnership {
  readonly branch: string
  readonly sourceRepository: string
}

export interface RelevantIssuePredicateContext {
  readonly forge: string
  readonly repositoryName: string
  readonly workItemPullRequestNumbers: ReadonlySet<number>
  readonly pendingSelfOwnership?: readonly PendingSelfOwnership[]
  readonly authorScope:
    | { readonly includeAll: true }
    | { readonly includeAll: false; readonly operatorLogin: string }
}

/**
 * Forges with no native sub-Issue hierarchy queried by this harness, so a
 * Ready Issue reporting `hierarchySupported: false` is expected rather than
 * anomalous. `forge` stays `string` here (this module has no Forge union of
 * its own to stay decoupled from `db-service`); kept as a Set so a third
 * such Forge is a one-line addition instead of another inline comparison.
 */
const FORGES_WITHOUT_HIERARCHY_SUPPORT: ReadonlySet<string> = new Set([
  "gitlab",
  "azure-devops",
])

export type ClosingPullRequestClassificationKind =
  | "exact_owned"
  | "pending_self"
  | "competing"
  | "deferred"

export interface ClassifiedClosingPullRequest {
  readonly number: number
  readonly repository: string
  readonly kind: ClosingPullRequestClassificationKind
}

export interface ClosingPullRequestClassification {
  readonly active: readonly ClassifiedClosingPullRequest[]
  readonly exactOwned: readonly ClassifiedClosingPullRequest[]
  readonly pendingSelf: readonly ClassifiedClosingPullRequest[]
  readonly competing: readonly ClassifiedClosingPullRequest[]
  readonly deferred: readonly ClassifiedClosingPullRequest[]
  readonly satisfiesClosingPullRequestCondition: boolean
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
  pullRequest: ClosingPullRequestPredicateShape,
  forge: string,
  issueState: string,
): boolean => {
  if (pullRequest.state === "OPEN") {
    return forge === "gitlab" || !pullRequest.isDraft
  }
  return pullRequest.state === "MERGED" && issueState !== "OPEN"
}

const sameIdentity = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase()

const sourceIdentity = (
  pullRequest: ClosingPullRequestPredicateShape,
): { readonly branch: string; readonly repository: string } | null => {
  const branch = pullRequest.sourceBranch?.trim() ?? ""
  const repository = pullRequest.sourceRepository?.trim() ?? ""
  if (branch === "" || repository === "") {
    return null
  }
  return { branch, repository }
}

const classifyActiveClosingPullRequest = (
  pullRequest: ClosingPullRequestPredicateShape,
  context: RelevantIssuePredicateContext,
): ClassifiedClosingPullRequest => {
  if (
    pullRequest.repository.toLowerCase() === context.repositoryName &&
    context.workItemPullRequestNumbers.has(pullRequest.number)
  ) {
    return {
      number: pullRequest.number,
      repository: pullRequest.repository,
      kind: "exact_owned",
    }
  }

  const pending = context.pendingSelfOwnership ?? []
  if (pending.length > 0) {
    const source = sourceIdentity(pullRequest)
    if (source === null) {
      return {
        number: pullRequest.number,
        repository: pullRequest.repository,
        kind: "deferred",
      }
    }
    const isPendingSelf = pending.some(
      (candidate) =>
        candidate.branch === source.branch &&
        sameIdentity(candidate.sourceRepository, source.repository),
    )
    return {
      number: pullRequest.number,
      repository: pullRequest.repository,
      kind: isPendingSelf ? "pending_self" : "competing",
    }
  }

  return {
    number: pullRequest.number,
    repository: pullRequest.repository,
    kind: "competing",
  }
}

export const classifyActiveClosingPullRequests = (
  issue: Pick<RelevantIssuePredicateShape, "state" | "closingPullRequests">,
  context: RelevantIssuePredicateContext,
): ClosingPullRequestClassification => {
  const active = issue.closingPullRequests
    .filter((pullRequest) =>
      activeClosingPullRequest(pullRequest, context.forge, issue.state),
    )
    .map((pullRequest) =>
      classifyActiveClosingPullRequest(pullRequest, context),
    )
  const exactOwned = active.filter((item) => item.kind === "exact_owned")
  const pendingSelf = active.filter((item) => item.kind === "pending_self")
  const competing = active.filter((item) => item.kind === "competing")
  const deferred = active.filter((item) => item.kind === "deferred")
  return {
    active,
    exactOwned,
    pendingSelf,
    competing,
    deferred,
    satisfiesClosingPullRequestCondition:
      active.length === 0 ||
      exactOwned.length > 0 ||
      pendingSelf.length > 0 ||
      deferred.length > 0,
  }
}

export const competingPullRequestIdentity = (
  pullRequest: Pick<ClassifiedClosingPullRequest, "repository" | "number">,
): string => `${pullRequest.repository}#${pullRequest.number}`

export interface CompetingIssueClosingPullRequestObservation {
  readonly issueNumber: number
  readonly identities: readonly {
    readonly repository: string
    readonly number: number
  }[]
}

export const formatCompetingIssueClosingPullRequestMessage = (
  identities: readonly string[],
): string => {
  const unique = [...new Set(identities)].sort((left, right) =>
    left.localeCompare(right),
  )
  if (unique.length === 0) {
    return "Open Issue-closing PR is not owned by this Work Item. Autonomous work stopped; review that PR, then Reset this Work Item to discard the local attempt."
  }
  if (unique.length === 1) {
    return `Open Issue-closing PR ${unique[0]} is not owned by this Work Item. Autonomous work stopped; review that PR, then Reset this Work Item to discard the local attempt.`
  }
  return `Open Issue-closing PRs ${unique.join(", ")} are not owned by this Work Item. Autonomous work stopped; review those PRs, then Reset this Work Item to discard the local attempt.`
}

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
  } else if (FORGES_WITHOUT_HIERARCHY_SUPPORT.has(context.forge)) {
    // GitLab and Azure DevOps have no native sub-Issue hierarchy queried by
    // this harness today, so `hierarchySupported: false` is an expected,
    // legitimate signal from those Forges rather than a bug — fall back to
    // the flat-Issue rules below. Any other Forge (GitHub) reporting
    // `hierarchySupported: false` is unexpected and fails closed instead.
    if (issue.state !== "OPEN") {
      hierarchyFailure = { _tag: "issue_not_open", state: issue.state }
    } else if (issue.parent !== null || issue.hasChildren) {
      hierarchyFailure = { _tag: "issue_hierarchy_unsupported" }
    }
  } else {
    hierarchyFailure = { _tag: "issue_hierarchy_unsupported" }
  }

  const classification = classifyActiveClosingPullRequests(issue, context)
  const satisfiesClosingPullRequestCondition =
    classification.satisfiesClosingPullRequestCondition
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
    classification.active.length > 0 &&
    !satisfiesClosingPullRequestCondition
  ) {
    return { _tag: "issue_closing_pull_request_unowned" }
  }

  if (!isIssueAuthorIncluded) {
    return { _tag: "issue_author_not_in_scope" }
  }

  throw new Error("Relevant Issue expression rejected valid facts")
}
