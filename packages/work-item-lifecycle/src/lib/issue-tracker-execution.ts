import { Effect } from "effect"
import type { RepositoryRecord } from "@ready-for-agent/db-service"
import {
  type IssueSource,
  type IssueTracker,
  behaviourNotImplemented,
} from "@ready-for-agent/lifecycle-model"
import type {
  LinearNotConfiguredError,
  LinearRequestError,
  LinearService,
} from "@ready-for-agent/linear-service"
import {
  completeLinearIssue,
  notifyLinearHumanAttention,
  notifyLinearPullRequest,
  notifyLinearWorkStarted,
} from "./linear-milestones.js"

/**
 * Tracker-side effects of executing a Work Item, dispatched on the Original
 * Issue Source's Issue Tracker kind (ADR 0073). Forge-hosted kinds have none
 * here: their Issue is the pull request's closing target, and Close Issue
 * closes it on the Forge. A context without a source is treated the same.
 */
const dispatch = <E, R>(
  source: IssueSource | undefined,
  behaviour: string,
  trackerOnly: {
    readonly linear: (
      source: IssueSource & { readonly tracker: "linear" },
    ) => Effect.Effect<void, E, R>
  },
): Effect.Effect<void, E, R> => {
  if (source === undefined) {
    return Effect.void
  }
  const tracker: IssueTracker = source.tracker
  switch (tracker) {
    case "github":
    case "gitlab":
    case "azure-devops":
      return Effect.void
    case "linear":
      return trackerOnly.linear({ ...source, tracker })
    case "fp":
      return Effect.sync(() => behaviourNotImplemented(tracker, behaviour))
    default: {
      const _exhaustive: never = tracker
      return _exhaustive
    }
  }
}

/** In Progress and the work-started milestone when implementation starts. */
export const notifyWorkStarted = (input: {
  readonly repository: RepositoryRecord
  readonly issueSource: IssueSource | undefined
  readonly workItemId: string
}): Effect.Effect<
  void,
  LinearRequestError | LinearNotConfiguredError,
  LinearService
> =>
  dispatch(input.issueSource, "work-started milestone", {
    linear: (issueSource) => notifyLinearWorkStarted({ ...input, issueSource }),
  })

/** Pull request milestone after the pull request is opened. */
export const notifyPullRequest = (input: {
  readonly issueSource: IssueSource | undefined
  readonly workItemId: string
  readonly pullRequestUrl: string
}): Effect.Effect<void, LinearRequestError, LinearService> =>
  dispatch(input.issueSource, "pull request milestone", {
    linear: (issueSource) => notifyLinearPullRequest({ ...input, issueSource }),
  })

/** Human attention milestone when a Work Item parks for a person. */
export const notifyHumanAttention = (input: {
  readonly issueSource: IssueSource | undefined
  readonly workItemId: string
  readonly reason: string
}): Effect.Effect<void, LinearRequestError, LinearService> =>
  dispatch(input.issueSource, "human attention milestone", {
    linear: (issueSource) =>
      notifyLinearHumanAttention({ ...input, issueSource }),
  })

/**
 * Close Issue on the tracker for a tracker-only Original Issue Source.
 * Returns false for a Forge-hosted source, which Close Issue closes on the
 * Forge instead.
 */
export const completeTrackerIssue = (input: {
  readonly repository: RepositoryRecord
  readonly issueSource: IssueSource | undefined
  readonly workItemId: string
  readonly summary: string
}): Effect.Effect<
  boolean,
  LinearRequestError | LinearNotConfiguredError,
  LinearService
> => {
  if (input.issueSource === undefined) {
    return Effect.succeed(false)
  }
  const tracker: IssueTracker = input.issueSource.tracker
  switch (tracker) {
    case "github":
    case "gitlab":
    case "azure-devops":
      return Effect.succeed(false)
    case "linear":
      return completeLinearIssue({
        ...input,
        issueSource: { ...input.issueSource, tracker },
      }).pipe(Effect.as(true))
    case "fp":
      return Effect.sync(() => behaviourNotImplemented(tracker, "Close Issue"))
    default: {
      const _exhaustive: never = tracker
      return _exhaustive
    }
  }
}
