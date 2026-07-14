import { Effect, FileSystem } from "effect"
import { Opencode } from "@ready-for-agent/opencode"
import {
  CommitInvalidWorktreeContextError,
  CommitOpenCodeError,
  CommitSessionContextMissingError,
  CommitWorktreeContextMissingError,
} from "./commit-errors.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"

const resolveWorktreePath = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = context.worktreePath
    if (worktreePath === null || worktreePath.trim() === "") {
      return yield* new CommitWorktreeContextMissingError({
        workItemId: context.workItemId,
        message: "Commit requires a worktree path persisted by Create Worktree",
      })
    }

    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(worktreePath)
    if (!exists) {
      return yield* new CommitInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path does not exist: ${worktreePath}`,
      })
    }

    const stat = yield* fs.stat(worktreePath)
    if (stat.type !== "Directory") {
      return yield* new CommitInvalidWorktreeContextError({
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
      new CommitSessionContextMissingError({
        workItemId: context.workItemId,
        message:
          "Commit requires a Session ID persisted by a successful Implement Step Run",
      }),
    )
  }
  return Effect.succeed(sessionId)
}

const buildCommitPrompt = (githubIssueNumber: number) =>
  [
    "Create a git commit for the implementation changes in this worktree.",
    "Follow this repository's commit message conventions (for example conventional commits if the repo uses them).",
    `The commit message must mention that it closes GitHub issue #${githubIssueNumber}.`,
    "Stage only the relevant implementation changes, then commit.",
    "If there is nothing left to commit, succeed without creating an empty commit.",
    "Do not open a pull request.",
  ].join("\n")

/**
 * Production Commit Lifecycle Step.
 * Continues the Implement OpenCode Session in the Work Item worktree and asks
 * it to create the local git commit, including that the commit closes the
 * Work Item's GitHub Issue. Success means the command exited successfully;
 * the step does not inspect the resulting git history.
 */
export const commit = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const sessionId = yield* resolveSessionId(context)
    const prompt = buildCommitPrompt(context.githubIssueNumber)

    const opencode = yield* Opencode
    yield* opencode
      .continue({
        sessionId,
        prompt,
        cwd: worktreePath,
        model: context.model,
        variant: context.variant,
        timeout: context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.commit,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CommitOpenCodeError({
              message: "OpenCode failed to commit the Work Item changes",
              worktreePath,
              sessionId,
              cause,
            }),
        ),
      )
  })
