import type { Forge, IssueTracker } from "./generated/forge.js"
import {
  type ForgeRelevancePolicy,
  relevancePolicyForForge,
} from "./relevance-policy.js"

/**
 * A behaviour this Issue Tracker kind does not have yet. Only a kind that is
 * not selectable may carry it (see {@link IssueTrackerDescription}), so no
 * Repository, Issue or Work Item of that kind can reach it; a consumer that
 * does reach it calls {@link behaviourNotImplemented}. It never falls back to
 * another kind's behaviour.
 */
export interface NotImplemented {
  readonly kind: "not_implemented"
}

/**
 * Which hosting Forges may select this Issue Tracker in Repository settings.
 *
 * `hosting_forge`: only the Repository's own hosting Forge (a Repository that
 * already uses the kind keeps it). `forges`: any of the listed hosting Forges.
 * `not_selectable`: never, with the reason shown to the operator.
 */
export type SelectableAvailability =
  | { readonly kind: "hosting_forge"; readonly mismatchMessage: string }
  | {
      readonly kind: "forges"
      readonly forges: readonly Forge[]
      readonly unavailableMessage: string
    }

export interface NotSelectable {
  readonly kind: "not_selectable"
  readonly message: string
}

export type IssueTrackerAvailability = SelectableAvailability | NotSelectable

/** Tracker-specific Repository settings the kind requires. */
export type IssueTrackerSettings =
  | { readonly kind: "none" }
  | { readonly kind: "linear_project_mapping" }

/**
 * Credential that Issue Polling needs before it may start.
 *
 * `hosting_forge`: the hosting Forge credential. `linear_api_key`: the
 * tracker's own vault secret. `none`: the operator's login on the machine,
 * nothing to probe.
 */
export type IssueTrackerCredential =
  | { readonly kind: "hosting_forge" }
  | { readonly kind: "linear_api_key" }
  | { readonly kind: "none" }

/**
 * How a Work Item finds its stored Issue: by the Forge issue number or by
 * the tracker-native identity.
 */
export type IssueIdentityLookup =
  | { readonly kind: "issue_number" }
  | { readonly kind: "native_id" }

/** How Implement presents the Issue to the agent. */
export type ImplementPresentation =
  | { readonly kind: "forge_issue" }
  | { readonly kind: "tracker_issue" }

/** What the pull request body says about the Issue. */
export type PullRequestReference =
  | { readonly kind: "forge_closing_reference" }
  | { readonly kind: "tracker_identity" }

/**
 * Lifecycle Step that follows a confirmed merge. `close_issue` carries the
 * completion summary published when no summary was persisted.
 */
export type AfterConfirmedMerge =
  | { readonly kind: "local_cleanup" }
  | { readonly kind: "close_issue"; readonly completionSummary: string }

/** Whether a parent Issue may start Implement All. */
export type ParentImplementAll =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly message: string }

interface Behaviours<Missing> {
  readonly settings: IssueTrackerSettings | Missing
  readonly credential: IssueTrackerCredential
  readonly issueIdentity: IssueIdentityLookup
  readonly presentation: ImplementPresentation | Missing
  readonly pullRequestReference: PullRequestReference | Missing
  readonly afterConfirmedMerge: AfterConfirmedMerge | Missing
  readonly parentImplementAll: ParentImplementAll | Missing
  readonly relevancePolicy: ForgeRelevancePolicy
}

/**
 * Everything the harness needs to know about one Issue Tracker kind, in one
 * place (ADR 0073). Code that varies by kind reads these facts or dispatches
 * exhaustively on the kind; it does not compare against kind names.
 *
 * A selectable kind has every behaviour: making a kind selectable while one
 * is still {@link NotImplemented} fails compilation.
 */
export type IssueTrackerDescription = { readonly displayName: string } & (
  | ({ readonly availability: SelectableAvailability } & Behaviours<never>)
  | ({ readonly availability: NotSelectable } & Behaviours<NotImplemented>)
)

const NOT_IMPLEMENTED: NotImplemented = { kind: "not_implemented" }

const forgeHostedDescription = (
  forge: Forge,
  displayName: string,
): IssueTrackerDescription => ({
  displayName,
  availability: {
    kind: "hosting_forge",
    mismatchMessage:
      "Forge-hosted Issue Trackers must match the Repository hosting Forge",
  },
  settings: { kind: "none" },
  credential: { kind: "hosting_forge" },
  issueIdentity: { kind: "issue_number" },
  presentation: { kind: "forge_issue" },
  pullRequestReference: { kind: "forge_closing_reference" },
  afterConfirmedMerge: { kind: "local_cleanup" },
  parentImplementAll: { kind: "available" },
  relevancePolicy: relevancePolicyForForge(forge),
})

/**
 * Linear and fp have native parent/child hierarchy like GitHub. Competing
 * GitHub PRs are out of scope for their discovery, so draft closing-PR
 * treatment is inactive.
 */
const trackerOnlyRelevancePolicy: ForgeRelevancePolicy = {
  hierarchyObservation: { kind: "required" },
  openDraftClosingPullRequest: { kind: "inactive" },
}

/**
 * One description per Issue Tracker kind. A kind added to the vocabulary
 * without an entry here fails compilation.
 */
export const ISSUE_TRACKER_DESCRIPTIONS = {
  github: forgeHostedDescription("github", "GitHub"),
  gitlab: forgeHostedDescription("gitlab", "GitLab"),
  "azure-devops": forgeHostedDescription("azure-devops", "Azure DevOps"),
  linear: {
    displayName: "Linear",
    availability: {
      kind: "forges",
      forges: ["github"],
      unavailableMessage:
        "Linear is available only for GitHub-hosted Repositories",
    },
    settings: { kind: "linear_project_mapping" },
    credential: { kind: "linear_api_key" },
    issueIdentity: { kind: "native_id" },
    presentation: { kind: "tracker_issue" },
    pullRequestReference: { kind: "tracker_identity" },
    afterConfirmedMerge: {
      kind: "close_issue",
      completionSummary:
        "Ready for Agent completed this Issue after the GitHub pull request merged.",
    },
    parentImplementAll: {
      kind: "unavailable",
      message:
        "Implement All is not available for Linear Issues in this release. Start eligible leaf Issues instead.",
    },
    relevancePolicy: trackerOnlyRelevancePolicy,
  },
  fp: {
    displayName: "fp",
    availability: {
      kind: "not_selectable",
      message: "fp is not yet available as an Issue Tracker",
    },
    settings: NOT_IMPLEMENTED,
    credential: { kind: "none" },
    issueIdentity: { kind: "native_id" },
    presentation: NOT_IMPLEMENTED,
    pullRequestReference: NOT_IMPLEMENTED,
    afterConfirmedMerge: NOT_IMPLEMENTED,
    parentImplementAll: NOT_IMPLEMENTED,
    relevancePolicy: trackerOnlyRelevancePolicy,
  },
} as const satisfies Record<IssueTracker, IssueTrackerDescription>

/**
 * Reaching a behaviour a kind does not have is a defect: the kind is not
 * selectable, so nothing of that kind should exist.
 */
export const behaviourNotImplemented = (
  tracker: IssueTracker,
  behaviour: string,
): never => {
  throw new Error(
    `Issue Tracker ${tracker} has no ${behaviour} yet and is not selectable`,
  )
}

export const describeIssueTracker = (
  tracker: IssueTracker,
): IssueTrackerDescription => ISSUE_TRACKER_DESCRIPTIONS[tracker]

/**
 * Why a parent Issue of this Issue Tracker kind may not start Implement All,
 * or null when it may.
 */
export const parentImplementAllRefusal = (
  tracker: IssueTracker,
): string | null => {
  const implementAll = describeIssueTracker(tracker).parentImplementAll
  switch (implementAll.kind) {
    case "available":
      return null
    case "unavailable":
      return implementAll.message
    case "not_implemented":
      return behaviourNotImplemented(tracker, "parent Implement All")
    default: {
      const _exhaustive: never = implementAll
      return _exhaustive
    }
  }
}

/** Relevance policy facts for a Repository's Issue Tracker kind. */
export const relevancePolicyForIssueTracker = (
  tracker: IssueTracker,
): ForgeRelevancePolicy => describeIssueTracker(tracker).relevancePolicy
