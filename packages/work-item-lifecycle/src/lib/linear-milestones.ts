import { Effect } from "effect"
import type { RepositoryRecord } from "@ready-for-agent/db-service"
import type { IssueSource } from "@ready-for-agent/lifecycle-model"
import {
  LinearNotConfiguredError,
  type LinearRequestError,
  LinearService,
  linearMilestoneMarker,
} from "@ready-for-agent/linear-service"

export const LINEAR_MERGE_COMPLETION_SUMMARY =
  "Ready for Agent completed this Issue after the GitHub pull request merged."

export const nextStateAfterConfirmedMerge = (
  source: IssueSource | undefined,
): "close_issue" | "local_cleanup" =>
  isLinearIssueSource(source) ? "close_issue" : "local_cleanup"

export const linearMergeCompletionSummary = (
  existing: string | null | undefined,
): string => {
  const persisted = existing?.trim()
  if (persisted !== undefined && persisted !== "") {
    return persisted
  }
  return LINEAR_MERGE_COMPLETION_SUMMARY
}

export const isLinearIssueSource = (
  source: IssueSource | undefined,
): source is IssueSource & { readonly tracker: "linear" } =>
  source?.tracker === "linear"

const commentBody = (prose: readonly string[], marker: string): string =>
  `${prose.filter((line) => line.length > 0).join("\n")}\n\n${marker}`

export const linearWorkStartedComment = (workItemId: string): string =>
  commentBody(
    [
      "Ready for Agent started implementation for this Issue.",
      `Work Item ${workItemId}.`,
    ],
    linearMilestoneMarker("work-started", workItemId),
  )

export const linearPullRequestComment = (
  workItemId: string,
  pullRequestUrl: string,
): string =>
  commentBody(
    [
      "Ready for Agent opened a GitHub pull request for this Issue:",
      pullRequestUrl,
    ],
    linearMilestoneMarker("pull-request", workItemId),
  )

export const linearHumanAttentionComment = (
  workItemId: string,
  reason: string,
): string =>
  commentBody(
    [
      "Ready for Agent needs human attention:",
      reason.trim() === ""
        ? "A human decision is required to continue."
        : reason.trim(),
    ],
    linearMilestoneMarker("human-attention", workItemId),
  )

export const linearCompletionComment = (
  workItemId: string,
  summary: string,
): string =>
  commentBody([summary.trim()], linearMilestoneMarker("completion", workItemId))

export const githubPullRequestUrl = (input: {
  readonly forgeHost: string
  readonly projectPath: string
  readonly pullRequestNumber: number
}): string =>
  `https://${input.forgeHost}/${input.projectPath}/pull/${input.pullRequestNumber}`

const requireLinearSource = (
  source: IssueSource | undefined,
): source is IssueSource & { readonly tracker: "linear" } =>
  isLinearIssueSource(source)

export const notifyLinearWorkStarted = (input: {
  readonly repository: RepositoryRecord
  readonly issueSource: IssueSource | undefined
  readonly workItemId: string
}): Effect.Effect<
  void,
  LinearRequestError | LinearNotConfiguredError,
  LinearService
> =>
  Effect.gen(function* () {
    if (!requireLinearSource(input.issueSource)) {
      return
    }
    const linear = yield* LinearService
    const issue = yield* linear.getIssue(input.issueSource.nativeId)
    const team = input.repository.linearWorkflowStatuses.find(
      (status) => status.teamId === issue.teamId,
    )
    if (team === undefined) {
      if (input.repository.issueTracker === "linear") {
        return yield* new LinearNotConfiguredError({
          repositoryId: input.repository.id,
          message: `No In Progress workflow status is configured for Linear team ${issue.teamKey}. Choose In Progress in Repository settings, then Retry.`,
        })
      }
    } else {
      yield* linear.updateIssueState(
        input.issueSource.nativeId,
        team.inProgressStateId,
      )
    }
    yield* linear.ensureMilestoneComment(
      input.issueSource.nativeId,
      linearMilestoneMarker("work-started", input.workItemId),
      linearWorkStartedComment(input.workItemId),
    )
  })

export const notifyLinearPullRequest = (input: {
  readonly issueSource: IssueSource | undefined
  readonly workItemId: string
  readonly pullRequestUrl: string
}): Effect.Effect<void, LinearRequestError, LinearService> =>
  Effect.gen(function* () {
    if (!requireLinearSource(input.issueSource)) {
      return
    }
    const linear = yield* LinearService
    yield* linear.ensureMilestoneComment(
      input.issueSource.nativeId,
      linearMilestoneMarker("pull-request", input.workItemId),
      linearPullRequestComment(input.workItemId, input.pullRequestUrl),
    )
  })

export const notifyLinearHumanAttention = (input: {
  readonly issueSource: IssueSource | undefined
  readonly workItemId: string
  readonly reason: string
}): Effect.Effect<void, LinearRequestError, LinearService> =>
  Effect.gen(function* () {
    if (!requireLinearSource(input.issueSource)) {
      return
    }
    const linear = yield* LinearService
    yield* linear.ensureMilestoneComment(
      input.issueSource.nativeId,
      linearMilestoneMarker("human-attention", input.workItemId),
      linearHumanAttentionComment(input.workItemId, input.reason),
    )
  })

/**
 * Close Issue for a Linear Original Issue Source: publish the completion
 * summary once, then move to the configured Done status. Already completed
 * or canceled Issues are accepted without a second transition.
 */
export const completeLinearIssue = (input: {
  readonly repository: RepositoryRecord
  readonly issueSource: IssueSource | undefined
  readonly workItemId: string
  readonly summary: string
}): Effect.Effect<
  void,
  LinearRequestError | LinearNotConfiguredError,
  LinearService
> =>
  Effect.gen(function* () {
    if (!requireLinearSource(input.issueSource)) {
      return
    }
    const linear = yield* LinearService
    const issue = yield* linear.getIssue(input.issueSource.nativeId)
    yield* linear.ensureMilestoneComment(
      input.issueSource.nativeId,
      linearMilestoneMarker("completion", input.workItemId),
      linearCompletionComment(input.workItemId, input.summary),
    )
    const team = input.repository.linearWorkflowStatuses.find(
      (status) => status.teamId === issue.teamId,
    )
    if (team === undefined) {
      if (input.repository.issueTracker === "linear") {
        return yield* new LinearNotConfiguredError({
          repositoryId: input.repository.id,
          message: `No Done workflow status is configured for Linear team ${issue.teamKey}. Choose Done in Repository settings, then Retry.`,
        })
      }
      return
    }
    yield* linear.updateIssueState(input.issueSource.nativeId, team.doneStateId)
  })
