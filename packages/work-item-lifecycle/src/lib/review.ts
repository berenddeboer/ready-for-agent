import { Effect, FileSystem } from "effect"
import { Opencode } from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import {
  ReviewInvalidWorktreeContextError,
  ReviewOpenCodeError,
  ReviewSessionContextMissingError,
  ReviewWorktreeContextMissingError,
} from "./review-errors.js"
import { DEFAULT_LIFECYCLE_MAX_DURATIONS } from "./types.js"

const REVIEW_PROMPT = "/review"

const resolveWorktreePath = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = context.worktreePath
    if (worktreePath === null || worktreePath.trim() === "") {
      return yield* new ReviewWorktreeContextMissingError({
        workItemId: context.workItemId,
        message: "Review requires a worktree path persisted by Create Worktree",
      })
    }

    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(worktreePath)
    if (!exists) {
      return yield* new ReviewInvalidWorktreeContextError({
        workItemId: context.workItemId,
        worktreePath,
        message: `Worktree path does not exist: ${worktreePath}`,
      })
    }

    const stat = yield* fs.stat(worktreePath)
    if (stat.type !== "Directory") {
      return yield* new ReviewInvalidWorktreeContextError({
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
      new ReviewSessionContextMissingError({
        workItemId: context.workItemId,
        message:
          "Review requires a Session ID persisted by a successful Implement Step Run",
      }),
    )
  }
  return Effect.succeed(sessionId)
}

/**
 * Production Review Lifecycle Step.
 * Continues the Implement OpenCode Session in the Work Item worktree with
 * `/review`. Success means the command exited successfully; findings are not
 * parsed and do not gate Complete.
 */
export const review = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const sessionId = yield* resolveSessionId(context)

    const opencode = yield* Opencode
    yield* opencode
      .continue({
        sessionId,
        prompt: REVIEW_PROMPT,
        cwd: worktreePath,
        model: context.model,
        variant: context.variant,
        timeout: context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.review,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ReviewOpenCodeError({
              message: "OpenCode failed to review the Work Item",
              worktreePath,
              sessionId,
              cause,
            }),
        ),
      )
  })
