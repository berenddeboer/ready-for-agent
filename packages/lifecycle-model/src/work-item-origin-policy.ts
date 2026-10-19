import { Effect, Schema } from "effect"
import { type WorkItemOrigin, isWorkItemOrigin } from "./generated/forge.js"
import type { OperationalLifecycleStep } from "./generated/work-item-state.js"
import type { IssueSource } from "./issue-source.js"

/**
 * A stored Work Item origin was missing or not a generated origin.
 * Callers must not treat that as an Issue Work Item.
 */
export class InvalidWorkItemOriginError extends Schema.TaggedError<InvalidWorkItemOriginError>()(
  "InvalidWorkItemOriginError",
  {
    value: Schema.String,
  },
) {}

const formatOriginValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }
  if (value === null) {
    return "null"
  }
  if (value === undefined) {
    return "undefined"
  }
  return typeof value
}

/**
 * Decode a stored Work Item origin. Unknown values, including null, fail.
 * They are not rewritten to `"issue"`.
 */
export const decodeWorkItemOrigin = (
  value: unknown,
): Effect.Effect<WorkItemOrigin, InvalidWorkItemOriginError> =>
  isWorkItemOrigin(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new InvalidWorkItemOriginError({ value: formatOriginValue(value) }),
      )

export type ConfirmedMergeNextState = "close_issue" | "local_cleanup"

/**
 * Answers every origin question the lifecycle used to re-check.
 * A new `WorkItemOrigin` must fill this record or the build fails.
 */
export interface WorkItemOriginPolicy {
  /** Destination after a confirmed merge. Linear Issue origin closes the Issue. */
  readonly nextStateAfterConfirmedMerge: (
    source: IssueSource | undefined,
  ) => ConfirmedMergeNextState
  /** Assess Changes / Commit no-change destination. */
  readonly noChangeNextState: ConfirmedMergeNextState
  /**
   * When a no-change outcome skips Commit, retarget a pause-before-Commit
   * to the no-change destination. Any other pause target is left unchanged.
   */
  readonly pauseTargetAfterNoChange: (
    pauseBeforeStep: OperationalLifecycleStep | null,
  ) => OperationalLifecycleStep | undefined
  /** This origin has no Issue, so Issue revalidation does not apply. */
  readonly skipsIssueRevalidation: boolean
  /** Parked attention can complete because the Issue left the store. */
  readonly completesWhenIssueNoLongerRelevant: boolean
  /** Ordinary remote work waits while the Repository CI Gate is closed. */
  readonly heldForClosedCiGate: boolean
  /** Close Issue is a valid step. */
  readonly closesIssue: boolean
  /** Implement follows the Issue path rather than the CI Repair path. */
  readonly implementsFromIssue: boolean
  /** Commit and Create PR omit an Issue-closing reference. */
  readonly omitsIssueClosingReference: boolean
  /** No-change confirmation asks about an Issue objective. */
  readonly noChangeConfirmsIssue: boolean
  /** Create PR may associate the pull request with a Forge Issue. */
  readonly associatesPullRequestWithIssue: boolean
  /** Abandon and Reset record a CI Repair suppress for the same failure. */
  readonly recordsCiRepairAbandonSuppress: boolean
  /** A confirmed merge records the CI Repair baseline floor. */
  readonly recordsCiRepairMergeFloor: boolean
  /** CI Gate Bypass can be authorized on this origin. */
  readonly canAuthorizeCiGateBypass: boolean
  /** A closed or missing Issue failure can be retried after revalidation. */
  readonly retriesWhenIssueClosedOrMissing: boolean
  /** Completion can move the CI Repair Baseline. */
  readonly tracksCiRepairBaseline: boolean
  readonly branchName: (input: {
    readonly slug: string
    readonly issueNumber: number
    readonly workItemId: string
  }) => string
  readonly worktreeDirectoryName: (input: {
    readonly issueNumber: number
    readonly workItemId: string
  }) => string
  readonly scopeIssueLine: (input: {
    readonly issueUrl: string | null
    readonly repositoryId: string
    readonly issueNumber: number
  }) => string
}

const pauseBeforeSkippedCommit =
  (
    next: ConfirmedMergeNextState,
  ): WorkItemOriginPolicy["pauseTargetAfterNoChange"] =>
  (pauseBeforeStep) =>
    pauseBeforeStep === "commit" ? next : undefined

const issueScopeLine = (input: {
  readonly issueUrl: string | null
  readonly repositoryId: string
  readonly issueNumber: number
}): string =>
  `Issue: ${input.issueUrl ?? `${input.repositoryId}#${input.issueNumber}`}`

const ORIGIN_POLICIES = {
  issue: {
    nextStateAfterConfirmedMerge: (source) =>
      source?.tracker === "linear" ? "close_issue" : "local_cleanup",
    noChangeNextState: "close_issue",
    pauseTargetAfterNoChange: pauseBeforeSkippedCommit("close_issue"),
    skipsIssueRevalidation: false,
    completesWhenIssueNoLongerRelevant: true,
    heldForClosedCiGate: true,
    closesIssue: true,
    implementsFromIssue: true,
    omitsIssueClosingReference: false,
    noChangeConfirmsIssue: true,
    associatesPullRequestWithIssue: true,
    recordsCiRepairAbandonSuppress: false,
    recordsCiRepairMergeFloor: false,
    canAuthorizeCiGateBypass: true,
    retriesWhenIssueClosedOrMissing: true,
    tracksCiRepairBaseline: false,
    branchName: ({ slug, issueNumber, workItemId }) =>
      `rfa/${slug}/${issueNumber}/${workItemId}`,
    worktreeDirectoryName: ({ issueNumber, workItemId }) =>
      `${issueNumber}-${workItemId}`,
    scopeIssueLine: issueScopeLine,
  },
  ci_repair: {
    nextStateAfterConfirmedMerge: () => "local_cleanup",
    noChangeNextState: "local_cleanup",
    pauseTargetAfterNoChange: pauseBeforeSkippedCommit("local_cleanup"),
    skipsIssueRevalidation: true,
    completesWhenIssueNoLongerRelevant: false,
    heldForClosedCiGate: false,
    closesIssue: false,
    implementsFromIssue: false,
    omitsIssueClosingReference: true,
    noChangeConfirmsIssue: false,
    associatesPullRequestWithIssue: false,
    recordsCiRepairAbandonSuppress: true,
    recordsCiRepairMergeFloor: true,
    canAuthorizeCiGateBypass: false,
    retriesWhenIssueClosedOrMissing: false,
    tracksCiRepairBaseline: true,
    branchName: ({ slug, workItemId }) => `rfa/${slug}/ci-repair/${workItemId}`,
    worktreeDirectoryName: ({ workItemId }) => `ci-repair-${workItemId}`,
    scopeIssueLine: () =>
      "Issue: none. This is a CI Repair Work Item. Do not create or close an Issue.",
  },
} as const satisfies Record<WorkItemOrigin, WorkItemOriginPolicy>

/**
 * Policy for one origin.
 *
 * An omitted origin is a legacy in-memory step context, which is an Issue
 * Work Item. Stored origins are decoded with `decodeWorkItemOrigin` first;
 * unknown stored values never reach this function as a fake `"issue"`.
 */
export const workItemOriginPolicy = (
  origin: WorkItemOrigin | undefined,
): WorkItemOriginPolicy => ORIGIN_POLICIES[origin ?? "issue"]

/** Commit / Create PR copy options selected by origin. */
export const publicationCopyOptions = (
  origin: WorkItemOrigin | undefined,
): { readonly ciRepair: true } | undefined =>
  workItemOriginPolicy(origin).omitsIssueClosingReference
    ? { ciRepair: true }
    : undefined
