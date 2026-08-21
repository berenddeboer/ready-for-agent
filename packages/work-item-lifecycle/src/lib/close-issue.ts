import { Effect } from "effect"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
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
 * publishes the summary and closes the Issue via the Repository's Forge service.
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
      (candidate) => candidate.issueNumber === context.issueNumber,
    )
    if (issue === undefined) {
      return yield* new CloseIssueEligibilityError({
        workItemId: context.workItemId,
        failureCode: "issue_not_found",
        message: `Issue #${context.issueNumber} is no longer present in the Issue store`,
      })
    }

    if (issue.state === "OPEN") {
      if (issue.hasChildren) {
        return yield* new CloseIssueEligibilityError({
          workItemId: context.workItemId,
          failureCode: "issue_is_parent",
          message: `Issue #${context.issueNumber} has children and is no longer a Leaf Issue`,
        })
      }
      if (issue.blockedBy.length > 0) {
        return yield* new CloseIssueEligibilityError({
          workItemId: context.workItemId,
          failureCode: "issue_blocked",
          message: `Issue #${context.issueNumber} is blocked by ${issue.blockedBy.length} Issue(s)`,
        })
      }
    }

    const forgeRepository = {
      forge: repository.forge,
      forgeHost: repository.forgeHost,
      projectPath: repository.projectPath,
    }
    switch (repository.forge) {
      case "gitlab": {
        const gitlab = yield* GitLabService
        yield* gitlab.ensureIssueCompletedWithSummary(
          forgeRepository,
          context.issueNumber,
          context.workItemId,
          summary,
        )
        return
      }
      case "azure-devops": {
        const azureDevOps = yield* AzureDevOpsService
        yield* azureDevOps.ensureIssueCompletedWithSummary(
          forgeRepository,
          context.issueNumber,
          context.workItemId,
          summary,
        )
        return
      }
      case "github": {
        const github = yield* GitHubService
        yield* github.ensureIssueCompletedWithSummary(
          forgeRepository,
          context.issueNumber,
          context.workItemId,
          summary,
        )
        return
      }
      default: {
        const _exhaustive: never = repository.forge
        return _exhaustive
      }
    }
  })
