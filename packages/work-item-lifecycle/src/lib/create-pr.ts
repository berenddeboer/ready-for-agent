import { Effect, FileSystem } from "effect"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import {
  CreatePrCredentialError,
  CreatePrInvalidWorktreeContextError,
  CreatePrLookupError,
  CreatePrOpenCodeError,
  CreatePrSessionContextMissingError,
  CreatePrWorktreeContextMissingError,
} from "./create-pr-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"
import { workItemBranchName } from "./worktree-names.js"

const resolveWorktreePath = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = context.worktreePath
    if (worktreePath === null || worktreePath.trim() === "") {
      return yield* new CreatePrWorktreeContextMissingError({
        workItemId: context.workItemId,
        message:
          "Create PR requires a worktree path persisted by Create Worktree",
      })
    }

    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(worktreePath)
    if (!exists) {
      return yield* new CreatePrInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path does not exist: ${worktreePath}`,
      })
    }

    const stat = yield* fs.stat(worktreePath)
    if (stat.type !== "Directory") {
      return yield* new CreatePrInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path is not a directory: ${worktreePath}`,
      })
    }

    return worktreePath
  })

const resolveSessionId = (context: LifecycleStepContext) => {
  const sessionId = context.sessionId
  if (sessionId === null || sessionId.trim() === "") {
    return Effect.fail(
      new CreatePrSessionContextMissingError({
        workItemId: context.workItemId,
        message:
          "Create PR requires a Session ID persisted by a successful Implement Step Run",
      }),
    )
  }
  return Effect.succeed(sessionId)
}

const buildCreatePrPrompt = (
  githubIssueNumber: number,
  branch: string,
  tokenName: string | undefined,
) =>
  [
    "Create a pull request for the committed implementation changes in this worktree.",
    `The current Work Item branch is ${branch}. Keep this branch checked out and use it as the pull request head.`,
    "Do not create or switch to another branch.",
    "Push this exact branch if needed, then open a PR against the repository default base branch.",
    "Create the pull request as a draft.",
    `The PR must reference GitHub issue #${githubIssueNumber} (for example Closes #${githubIssueNumber}).`,
    "Follow this repository's PR title and body conventions.",
    `If a suitable open PR whose head is exactly ${branch} already exists, succeed without creating a duplicate.`,
    "Do not merge the pull request.",
    ...(tokenName === undefined
      ? []
      : [
          `Use Keymaxxer secret ${tokenName} via keymaxxer_run for any GitHub CLI or API access; never put secret values in the environment.`,
        ]),
  ].join("\n")

/**
 * Production Create PR Lifecycle Step.
 * Continues the Implement OpenCode Session in the Work Item worktree and asks
 * it to open a pull request for the committed work, linking the Work Item's
 * GitHub Issue. Success requires resolving the resulting open PR so its exact
 * identity can be persisted on the Work Item.
 */
export const createPr = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const sessionId = yield* resolveSessionId(context)

    const db = yield* DbService
    const repositories = yield* db.listRepositories.pipe(
      Effect.mapError(
        (cause) =>
          new CreatePrCredentialError({
            repositoryId: context.repositoryId,
            message: "Failed to resolve the Work Item repository",
            cause,
          }),
      ),
    )
    const repository = repositories.find(
      ({ id }) => id === context.repositoryId,
    )
    if (repository === undefined) {
      return yield* new CreatePrCredentialError({
        repositoryId: context.repositoryId,
        message: `Repository ${context.repositoryId} was not found`,
      })
    }

    const keymaxxer = yield* KeymaxxerService
    const tokenName =
      keymaxxer.enabled === false
        ? undefined
        : yield* keymaxxer
            .findSecret({
              provider: "github",
              account: `${repository.githubOwner}/${repository.githubRepo}`,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new CreatePrCredentialError({
                    repositoryId: context.repositoryId,
                    message:
                      "Failed to resolve the repository GitHub credential",
                    cause,
                  }),
              ),
            )
    if (tokenName === null) {
      return yield* new CreatePrCredentialError({
        repositoryId: context.repositoryId,
        message: `No GitHub credential is configured for ${repository.githubOwner}/${repository.githubRepo}`,
      })
    }

    const branch = workItemBranchName({
      githubOwner: repository.githubOwner,
      githubRepo: repository.githubRepo,
      githubIssueNumber: context.githubIssueNumber,
      workItemId: context.workItemId,
    })

    const timeout =
      context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.create_pr
    const opencode = yield* Opencode
    yield* opencode
      .continue({
        sessionId,
        prompt: buildCreatePrPrompt(
          context.githubIssueNumber,
          branch,
          tokenName,
        ),
        cwd: worktreePath,
        model: context.model,
        variant: context.variant,
        timeout,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CreatePrOpenCodeError({
              message: "OpenCode failed to create a pull request",
              worktreePath,
              sessionId,
              cause,
            }),
        ),
      )

    const github = yield* GitHubService
    return yield* github
      .getOpenPullRequestNumber(
        { owner: repository.githubOwner, name: repository.githubRepo },
        branch,
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new CreatePrLookupError({
              repositoryId: context.repositoryId,
              message: `Failed to resolve the open pull request for ${repository.githubOwner}/${repository.githubRepo}:${branch}`,
              cause,
            }),
        ),
      )
  })
