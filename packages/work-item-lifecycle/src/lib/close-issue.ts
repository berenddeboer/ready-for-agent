import { Effect } from "effect"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService, type IssueRecord } from "@ready-for-agent/db-service"
import { resolveForgeIssueOperations } from "@ready-for-agent/forge-contract"
import { GitHubService } from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import { formatIssueDisplayId } from "@ready-for-agent/lifecycle-model"
import {
  CloseIssueContextError,
  CloseIssueEligibilityError,
  CloseIssueSummaryMissingError,
} from "./close-issue-errors.js"
import { issueOperationsForge } from "./issue-source-execution.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  completeLinearIssue,
  isLinearIssueSource,
} from "./linear-milestones.js"

const issueLabel = (context: LifecycleStepContext): string =>
  isLinearIssueSource(context.issueSource)
    ? formatIssueDisplayId(context.issueSource.displayId)
    : `#${context.issueNumber}`

const findStoredIssue = (
  issues: readonly IssueRecord[],
  context: LifecycleStepContext,
): IssueRecord | undefined => {
  if (isLinearIssueSource(context.issueSource)) {
    const nativeId = context.issueSource.nativeId
    return issues.find((candidate) => candidate.nativeId === nativeId)
  }
  return issues.find(
    (candidate) => candidate.issueNumber === context.issueNumber,
  )
}

const rejectIfOpenAndIneligible = (
  context: LifecycleStepContext,
  issue: IssueRecord,
): CloseIssueEligibilityError | null => {
  if (issue.state !== "OPEN") {
    return null
  }
  const label = issueLabel(context)
  if (issue.hasChildren) {
    return new CloseIssueEligibilityError({
      workItemId: context.workItemId,
      failureCode: "issue_is_parent",
      message: `Issue ${label} has children and is no longer a Leaf Issue`,
    })
  }
  if (issue.blockedBy.length > 0) {
    return new CloseIssueEligibilityError({
      workItemId: context.workItemId,
      failureCode: "issue_blocked",
      message: `Issue ${label} is blocked by ${issue.blockedBy.length} Issue(s)`,
    })
  }
  return null
}

/**
 * Production Close Issue Lifecycle Step for a confirmed No-Change Outcome.
 * Revalidates Issue eligibility immediately before mutation (open Leaf Issues
 * with no blockers; already-closed Issues are accepted), then idempotently
 * publishes the summary and closes the Issue via the Work Item's Original
 * Issue Source rather than the Repository's current Issue Tracker. Linear
 * sources complete with the configured Done status and do not create a PR.
 */
export const closeIssue = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const summary = context.completionSummary
    if (summary === null || summary.trim() === "") {
      return yield* new CloseIssueSummaryMissingError({
        workItemId: context.workItemId,
        message:
          "Close Issue requires a non-blank completion summary persisted by the confirming step",
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
    const issue = findStoredIssue(issues, context)
    if (issue === undefined) {
      return yield* new CloseIssueEligibilityError({
        workItemId: context.workItemId,
        failureCode: "issue_not_found",
        message: `Issue ${issueLabel(context)} is no longer present in the Issue store`,
      })
    }

    const ineligible = rejectIfOpenAndIneligible(context, issue)
    if (ineligible !== null) {
      return yield* ineligible
    }

    if (isLinearIssueSource(context.issueSource)) {
      return yield* completeLinearIssue({
        repository,
        issueSource: context.issueSource,
        workItemId: context.workItemId,
        summary,
      })
    }

    const issueForge = issueOperationsForge(
      context.issueSource,
      repository.forge,
    )
    if (issueForge === null) {
      return yield* new CloseIssueContextError({
        workItemId: context.workItemId,
        message: "Close Issue requires a Forge-hosted Original Issue Source",
      })
    }
    const forgeRepository = {
      forge: issueForge,
      forgeHost: repository.forgeHost,
      projectPath: repository.projectPath,
    }
    const github = yield* GitHubService
    const gitlab = yield* GitLabService
    const azureDevOps = yield* AzureDevOpsService
    yield* resolveForgeIssueOperations(issueForge, {
      github,
      gitlab,
      azureDevOps,
    }).ensureIssueCompletedWithSummary(
      forgeRepository,
      context.issueNumber,
      context.workItemId,
      summary,
    )
  })
