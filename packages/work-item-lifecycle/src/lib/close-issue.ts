import { Effect } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import {
  CloseIssueContextError,
  CloseIssueEligibilityError,
  CloseIssueSummaryMissingError,
} from "./close-issue-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"

/**
 * Production Close Issue Lifecycle Step for a confirmed No-Change Outcome.
 * Revalidates Issue eligibility immediately before mutation (open Leaf Issues
 * with no blockers; already-closed Issues are accepted), then idempotently
 * publishes the summary and closes the Issue as COMPLETED via GitHubService.
 */
export const closeIssue = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const summary = context.completionSummary
    if (summary === null || summary.trim() === "") {
      return yield* new CloseIssueSummaryMissingError({
        workItemId: context.workItemId,
        message:
          "Close Issue requires a non-blank completion summary persisted by Assess Changes",
      })
    }

    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new CloseIssueContextError({
        workItemId: context.workItemId,
        message: `Repository ${context.repositoryId} was not found`,
      })
    }

    const issues = yield* db.listIssues(context.repositoryId)
    const issue = issues.find(
      (candidate) => candidate.githubIssueNumber === context.githubIssueNumber,
    )
    if (issue === undefined) {
      return yield* new CloseIssueEligibilityError({
        workItemId: context.workItemId,
        failureCode: "issue_not_found",
        message: `Issue #${context.githubIssueNumber} is no longer present in the Issue store`,
      })
    }

    if (issue.state === "OPEN") {
      if (issue.hasChildren) {
        return yield* new CloseIssueEligibilityError({
          workItemId: context.workItemId,
          failureCode: "issue_is_parent",
          message: `Issue #${context.githubIssueNumber} has children and is no longer a Leaf Issue`,
        })
      }
      if (issue.blockedBy.length > 0) {
        return yield* new CloseIssueEligibilityError({
          workItemId: context.workItemId,
          failureCode: "issue_blocked",
          message: `Issue #${context.githubIssueNumber} is blocked by ${issue.blockedBy.length} Issue(s)`,
        })
      }
    }

    const github = yield* GitHubService
    yield* github.ensureIssueCompletedWithSummary(
      { owner: repository.githubOwner, name: repository.githubRepo },
      context.githubIssueNumber,
      context.workItemId,
      summary,
    )
  })
