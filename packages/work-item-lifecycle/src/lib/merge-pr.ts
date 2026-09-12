import { Effect, Schema } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { completeAzureBoardsIssueAfterNativeMerge } from "@ready-for-agent/forge-contract"
import {
  forgePullRequestMutations,
  toForgeRepository,
} from "./forge-mutation.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { resolveEffectiveMergePolicy } from "./merge-policy.js"
import { workItemBranchName } from "./worktree-names.js"

export class MergePrContextError extends Schema.TaggedErrorClass<MergePrContextError>()(
  "MergePrContextError",
  {
    message: Schema.String,
  },
) {}

const AZURE_BOARDS_MERGE_COMPLETION_SUMMARY =
  "Completed after the pull request merged."

const azureBoardsMergeCompletionSummary = (
  context: LifecycleStepContext,
): string => {
  const persisted = context.completionSummary?.trim()
  if (persisted !== undefined && persisted !== "") {
    return persisted
  }
  return AZURE_BOARDS_MERGE_COMPLETION_SUMMARY
}

/**
 * Production Merge PR Lifecycle Step.
 * After Decide PR Merge chooses clanker merge, merges the open PR/MR on the
 * Work Item branch via the Forge API (token-backed; expected head SHA).
 * GitHub squash-merges; GitLab and Azure DevOps defer merge method to
 * project/repository settings. On Azure DevOps, a successful merge then
 * completes the Boards Issue if it is still open (harness-owned backup for
 * `transitionWorkItems`). GitHub/GitLab native closing is unchanged;
 * human-observed merge paths do not write completion here.
 */
export const mergePr = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    if (context.worktreePath === null || context.worktreePath.trim() === "") {
      return yield* new MergePrContextError({
        message: "Merge PR requires a persisted worktree path",
      })
    }
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new MergePrContextError({
        message: `Repository ${context.repositoryId} was not found`,
      })
    }
    const branch = workItemBranchName({
      projectPath: repository.projectPath,
      issueNumber: context.issueNumber,
      workItemId: context.workItemId,
    })
    const effectivePolicy = resolveEffectiveMergePolicy({
      repositoryMergePolicy: repository.mergePolicy,
      workItemMergeMode: context.mergeMode,
      workItemAutoMergeOverride: context.autoMergeOverride,
    })
    const options =
      effectivePolicy === "always" ? { acceptNoChecks: true } : undefined
    const mutations = yield* forgePullRequestMutations(repository)
    const forgeRepository = toForgeRepository(repository)
    const result = yield* mutations.mergePullRequest(
      forgeRepository,
      branch,
      options,
    )
    if (mutations.forge !== "azure-devops") {
      return result
    }
    return yield* completeAzureBoardsIssueAfterNativeMerge({
      result,
      completeIssue: mutations.ensureIssueCompletedWithSummary,
      repository: forgeRepository,
      issueNumber: context.issueNumber,
      workItemId: context.workItemId,
      summaryMarkdown: azureBoardsMergeCompletionSummary(context),
    })
  })
