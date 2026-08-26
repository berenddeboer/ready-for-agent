import { Effect } from "effect"
import { AgentBackend, agentBackendLabel } from "@ready-for-agent/agent-backend"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService, type RepositoryRecord } from "@ready-for-agent/db-service"
import {
  GitHubService,
  type GitHubThrottledError,
  formatUserFacingError,
  isGitHubThrottledError,
  logErrorAnnotations,
} from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import {
  toAzureDevOpsRepository,
  toGitHubRepository,
  toGitLabRepository,
} from "./agent-turn-forge-auth.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  MarkPrReadyForReviewContextError,
  type MarkPrReadyForReviewError,
  MarkPrReadyForReviewOpenCodeError,
  MarkPrReadyForReviewPostconditionError,
  MarkPrReadyForReviewSessionContextMissingError,
} from "./mark-pr-ready-for-review-errors.js"
import type { NativeAttemptOutcome } from "./repair-fallback.js"
import { repairFallback } from "./repair-fallback.js"
import { promptUserContentSection } from "./sanitize-prompt-user-content.js"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  type LifecycleStepCompletion,
} from "./types.js"
import { workItemBranchName } from "./worktree-names.js"

const DIAGNOSTIC_CHAR_LIMIT = 4_000

export type MarkPrReadyForReviewResult = {
  readonly completion: LifecycleStepCompletion
}

const errorMessage = (cause: unknown): string =>
  formatUserFacingError(cause, "Unknown error")

const boundDiagnostics = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.length <= DIAGNOSTIC_CHAR_LIMIT) {
    return trimmed === "" ? "(no output)" : trimmed
  }
  return `${trimmed.slice(0, DIAGNOSTIC_CHAR_LIMIT)}\n…(truncated)`
}

const resolveWorktreePath = (context: LifecycleStepContext) => {
  const worktreePath = context.worktreePath
  if (worktreePath === null || worktreePath.trim() === "") {
    return Effect.fail(
      new MarkPrReadyForReviewContextError({
        message: "Mark PR ready for review requires a persisted worktree path",
      }),
    )
  }
  return Effect.succeed(worktreePath)
}

const resolveSessionId = (context: LifecycleStepContext) => {
  const sessionId = context.sessionId
  if (sessionId === null || sessionId.trim() === "") {
    return Effect.fail(
      new MarkPrReadyForReviewSessionContextMissingError({
        workItemId: context.workItemId,
        message:
          "Mark PR ready for review agent fallback requires a Session ID persisted by a successful Implement Step Run",
      }),
    )
  }
  return Effect.succeed(sessionId)
}

const resolveRepositoryRecord = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const db = yield* DbService
    const repositories = yield* db.listRepositories
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new MarkPrReadyForReviewContextError({
        message: `Repository ${context.repositoryId} was not found`,
      })
    }
    return repository
  })

/**
 * Independent check of the postcondition: the pull/merge request for the
 * Work Item branch is no longer a draft. Never trusts a native mutation's
 * own report — always re-derived from the Forge's own draft field. A soft
 * transport/API failure (other than GitHub throttling, which must still
 * surface) is treated as not-yet-established so one repair Agent Turn is
 * still attempted rather than hard-failing the step.
 */
const checkReadyForReview = (
  context: LifecycleStepContext,
  repository: RepositoryRecord,
  branch: string,
) =>
  Effect.gen(function* () {
    switch (repository.forge) {
      case "gitlab": {
        const gitlab = yield* GitLabService
        const status = yield* gitlab
          .getPullRequestCheckStatus(toGitLabRepository(repository), branch)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Soft ready-for-review check failed; treating as not yet ready",
                {
                  step: "mark_pr_ready_for_review",
                  repositoryId: context.repositoryId,
                  projectPath: repository.projectPath,
                  branch,
                  cause,
                },
              ).pipe(Effect.as(null)),
            ),
          )
        return status !== null && status.isDraft === false
          ? (true as const)
          : null
      }
      case "azure-devops": {
        const azureDevOps = yield* AzureDevOpsService
        const status = yield* azureDevOps
          .getPullRequestCheckStatus(
            toAzureDevOpsRepository(repository),
            branch,
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Soft ready-for-review check failed; treating as not yet ready",
                {
                  step: "mark_pr_ready_for_review",
                  repositoryId: context.repositoryId,
                  projectPath: repository.projectPath,
                  branch,
                  cause,
                },
              ).pipe(Effect.as(null)),
            ),
          )
        return status !== null && status.isDraft === false
          ? (true as const)
          : null
      }
      case "github": {
        const github = yield* GitHubService
        const status = yield* github
          .getPullRequestCheckStatus(toGitHubRepository(repository), branch)
          .pipe(
            Effect.catch((cause) =>
              isGitHubThrottledError(cause)
                ? Effect.fail(cause)
                : Effect.logWarning(
                    "Soft ready-for-review check failed; treating as not yet ready",
                    {
                      step: "mark_pr_ready_for_review",
                      repositoryId: context.repositoryId,
                      projectPath: repository.projectPath,
                      branch,
                      ...logErrorAnnotations(cause),
                    },
                  ).pipe(Effect.as(null)),
            ),
          )
        return status !== null && status.isDraft === false
          ? (true as const)
          : null
      }
      default: {
        const _exhaustive: never = repository.forge
        return _exhaustive
      }
    }
  })

const attemptNativeMarkReady = (
  repository: RepositoryRecord,
  branch: string,
): Effect.Effect<
  NativeAttemptOutcome,
  GitHubThrottledError,
  GitHubService | GitLabService | AzureDevOpsService
> =>
  Effect.gen(function* () {
    switch (repository.forge) {
      case "gitlab": {
        const gitlab = yield* GitLabService
        return yield* gitlab
          .markPullRequestReadyForReview(toGitLabRepository(repository), branch)
          .pipe(
            Effect.map((): NativeAttemptOutcome => ({ ok: true })),
            Effect.catch((cause) =>
              Effect.succeed<NativeAttemptOutcome>({
                ok: false,
                diagnostics: boundDiagnostics(
                  `markPullRequestReadyForReview failed: ${errorMessage(cause)}`,
                ),
              }),
            ),
          )
      }
      case "azure-devops": {
        const azureDevOps = yield* AzureDevOpsService
        return yield* azureDevOps
          .markPullRequestReadyForReview(
            toAzureDevOpsRepository(repository),
            branch,
          )
          .pipe(
            Effect.map((): NativeAttemptOutcome => ({ ok: true })),
            Effect.catch((cause) =>
              Effect.succeed<NativeAttemptOutcome>({
                ok: false,
                diagnostics: boundDiagnostics(
                  `markPullRequestReadyForReview failed: ${errorMessage(cause)}`,
                ),
              }),
            ),
          )
      }
      case "github": {
        const github = yield* GitHubService
        return yield* github
          .markPullRequestReadyForReview(toGitHubRepository(repository), branch)
          .pipe(
            Effect.map((): NativeAttemptOutcome => ({ ok: true })),
            Effect.catch((cause) =>
              isGitHubThrottledError(cause)
                ? Effect.fail(cause)
                : Effect.succeed<NativeAttemptOutcome>({
                    ok: false,
                    diagnostics: boundDiagnostics(
                      `markPullRequestReadyForReview failed: ${errorMessage(cause)}`,
                    ),
                  }),
            ),
          )
      }
      default: {
        const _exhaustive: never = repository.forge
        return _exhaustive
      }
    }
  })

const buildMarkPrReadyForReviewFallbackPrompt = (input: {
  readonly branch: string
  readonly diagnostics: string
}): string =>
  [
    "The harness attempted to mark this Work Item's pull/merge request as ready for review (clear its draft flag) and failed.",
    `The current Work Item branch is ${input.branch}. Its status checks are already green, or it has no checks and is past the Check-Start Deadline, so the pull/merge request is ready to leave draft.`,
    "Repair the underlying problem and mark that exact pull/merge request ready for review yourself — for example `gh pr ready <number>`, `glab mr update <id> --ready`, or the Azure DevOps equivalent that clears the draft flag.",
    "Do not create a new pull/merge request, push new commits, or merge the pull/merge request.",
    "",
    "Bounded native failure diagnostics:",
    promptUserContentSection("diagnostics", input.diagnostics),
  ].join("\n")

const askAgentToRepairMarkReady = (
  context: LifecycleStepContext,
  worktreePath: string,
  sessionId: string,
  branch: string,
  diagnostics: string,
) =>
  Effect.gen(function* () {
    const agentBackend = yield* AgentBackend
    yield* agentBackend
      .continueTurn({
        sessionId,
        prompt: buildMarkPrReadyForReviewFallbackPrompt({
          branch,
          diagnostics,
        }),
        cwd: worktreePath,
        model: context.model,
        thinkingLevel: context.thinkingLevel,
        timeout:
          context.maxDuration ??
          DEFAULT_LIFECYCLE_MAX_DURATIONS.mark_pr_ready_for_review,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MarkPrReadyForReviewOpenCodeError({
              message: `${agentBackendLabel(context.agentBackend)} failed to mark the pull request ready for review`,
              worktreePath,
              sessionId,
              cause,
            }),
        ),
      )
  })

/**
 * Production Mark PR Ready for Review Lifecycle Step.
 * After status checks are green, converts the draft PR/MR on the Work Item
 * branch to ready for review (GitHub GraphQL, GitLab draft flag, or Azure
 * DevOps `isDraft` field). Uses Repair Fallback, continuing the Work Item's
 * canonical Session for one bounded Agent Turn, only when the native path
 * does not establish that the pull/merge request is no longer a draft —
 * triggered by any failure the Forge's handler for this step reports, not a
 * narrower subset.
 */
export const markPrReadyForReview = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const repository = yield* resolveRepositoryRecord(context)
    const branch = workItemBranchName({
      projectPath: repository.projectPath,
      issueNumber: context.issueNumber,
      workItemId: context.workItemId,
    })

    const outcome = yield* repairFallback<
      true,
      string,
      MarkPrReadyForReviewError | GitHubThrottledError,
      GitHubService | GitLabService | AzureDevOpsService | AgentBackend
    >({
      checkAlreadySatisfied: checkReadyForReview(context, repository, branch),
      attemptNative: attemptNativeMarkReady(repository, branch),
      checkAfterNative: () => checkReadyForReview(context, repository, branch),
      buildDiagnosticsAfterNative: (native) =>
        Effect.succeed(
          boundDiagnostics(
            native.ok
              ? "Native mark-ready-for-review reported success but the pull/merge request is still a draft"
              : native.diagnostics,
          ),
        ),
      prepareAgentFallback: resolveSessionId(context),
      askAgentToFinish: (diagnostics, sessionId) =>
        askAgentToRepairMarkReady(
          context,
          worktreePath,
          sessionId,
          branch,
          diagnostics,
        ),
      checkAfterFallback: checkReadyForReview(context, repository, branch),
      buildDiagnosticsAfterFallback: (diagnosticsAfterNative) =>
        Effect.succeed(diagnosticsAfterNative),
      onPersistentFailure: (diagnostics) =>
        new MarkPrReadyForReviewPostconditionError({
          repositoryId: context.repositoryId,
          message: `Pull/merge request for ${repository.projectPath}:${branch} is still a draft after native attempt and agent fallback`,
          diagnostics,
        }),
    })

    return {
      completion: outcome.completion,
    } satisfies MarkPrReadyForReviewResult
  })
