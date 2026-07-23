import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DbService } from "@ready-for-agent/db-service"
import { Opencode } from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { CurrentStepRun } from "./opencode-session-limiter.js"
import {
  ReviewInvalidWorktreeContextError,
  ReviewOpenCodeError,
  ReviewResultError,
  ReviewSessionContextMissingError,
  ReviewWorktreeContextMissingError,
} from "./review-errors.js"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  REVIEW_REVIEWING_MESSAGE,
  STEP_RUN_REASON,
} from "./types.js"

export type ReviewResult =
  | { readonly _tag: "clean" }
  | { readonly _tag: "has_findings" }

const buildReviewingPrompt = () =>
  [
    "/review",
    "After the review, do not edit files, commit, push, open pull requests, or apply findings in this turn.",
    "End your final response with exactly one machine-readable result line:",
    "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
    "or",
    "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS",
  ].join("\n")

/**
 * Parse the unique final READY_FOR_AGENT_RESULT line from a reviewing pass.
 * Returns null for missing, duplicate, non-final, or unrecognized markers.
 */
export const parseReviewResult = (output: string): ReviewResult | null => {
  const lines = output.split("\n").map((line) => line.trim())
  const nonEmptyLines = lines.filter((line) => line !== "")
  const resultLines = lines.filter((line) =>
    /^READY_FOR_AGENT_RESULT:/i.test(line),
  )
  const finalLine = nonEmptyLines.at(-1)

  if (
    resultLines.length !== 1 ||
    finalLine === undefined ||
    finalLine !== resultLines[0]
  ) {
    return null
  }

  if (/^READY_FOR_AGENT_RESULT:\s*REVIEW_CLEAN$/i.test(finalLine)) {
    return { _tag: "clean" }
  }

  if (/^READY_FOR_AGENT_RESULT:\s*REVIEW_HAS_FINDINGS$/i.test(finalLine)) {
    return { _tag: "has_findings" }
  }

  return null
}

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

const markReviewingPhase = Effect.gen(function* () {
  const current = yield* CurrentStepRun
  if (current === null) {
    return
  }
  const sql = yield* SqlClient.SqlClient
  const db = yield* DbService
  const now = Date.now()
  yield* sql.unsafe(
    `UPDATE step_run
     SET reason_code = ?,
         reason_message = ?,
         updated_at = ?
     WHERE id = ?
       AND status = 'running'`,
    [
      STEP_RUN_REASON.reviewReviewing,
      REVIEW_REVIEWING_MESSAGE,
      now,
      current.stepRunId,
    ],
  )
  yield* db.notifyWorkItemsChanged(current.repositoryId)
}).pipe(
  Effect.catch((error) =>
    Effect.logWarning("Failed to mark Review Step Run as reviewing", {
      error,
    }),
  ),
  Effect.asVoid,
)

/**
 * Production Review Lifecycle Step — reviewing pass.
 * Continues the Implement OpenCode Session with `/review` plus a harness
 * READY_FOR_AGENT_RESULT contract, using the Work Item review model/variant.
 * Returns a structured reviewing outcome; does not apply findings.
 */
export const review = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const sessionId = yield* resolveSessionId(context)

    yield* markReviewingPhase

    const opencode = yield* Opencode
    const result = yield* opencode
      .continue({
        sessionId,
        prompt: buildReviewingPrompt(),
        cwd: worktreePath,
        model: context.reviewModel,
        variant: context.reviewVariant,
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

    const parsed = parseReviewResult(result.assistantText)
    if (parsed === null) {
      return yield* new ReviewResultError({
        workItemId: context.workItemId,
        message:
          "OpenCode did not report a unique final READY_FOR_AGENT_RESULT: REVIEW_CLEAN or REVIEW_HAS_FINDINGS",
      })
    }
    return parsed
  })
