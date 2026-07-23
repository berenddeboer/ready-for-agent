import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DbService } from "@ready-for-agent/db-service"
import { Opencode } from "@ready-for-agent/opencode"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { CurrentStepRun } from "./opencode-session-limiter.js"
import { preCommit } from "./pre-commit.js"
import {
  ReviewInvalidWorktreeContextError,
  ReviewOpenCodeError,
  ReviewResultError,
  ReviewSessionContextMissingError,
  ReviewWorktreeContextMissingError,
} from "./review-errors.js"
import {
  DEFAULT_LIFECYCLE_MAX_DURATIONS,
  REVIEW_APPLYING_FINDINGS_MESSAGE,
  REVIEW_PRE_COMMIT_MESSAGE,
  REVIEW_REVIEWING_MESSAGE,
  STEP_RUN_REASON,
} from "./types.js"

/** Max build-model apply rounds per Review Step Run before Needs Human. */
export const MAX_REVIEW_FIX_ROUNDS = 5

/** Operator-visible reason when Review Fix Rounds are exhausted. */
export const REVIEW_FIX_LIMIT_REASON = `Review fix limit reached (${MAX_REVIEW_FIX_ROUNDS}); inspect the worktree or address remaining findings, then Retry.`

/** Final Review step outcome after reviewing, optional apply, and fix rounds. */
export type ReviewResult =
  | { readonly _tag: "clean" }
  | { readonly _tag: "deferred"; readonly reason: string }
  | { readonly _tag: "needs_human"; readonly reason: string }

/** Machine-readable outcome of the reviewing (/review) pass only. */
export type ReviewingPassResult =
  | { readonly _tag: "clean" }
  | { readonly _tag: "has_findings" }

/** Machine-readable outcome of the apply-findings pass. */
export type ApplyReviewResult =
  | { readonly _tag: "clean" }
  | { readonly _tag: "deferred"; readonly reason: string }
  | { readonly _tag: "fixed" }

const buildReviewingPrompt = () =>
  [
    "/review",
    "After the review, do not edit files, commit, push, open pull requests, or apply findings in this turn.",
    "End your final response with exactly one machine-readable result line:",
    "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
    "or",
    "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS",
  ].join("\n")

const buildApplyFindingsPrompt = () =>
  [
    "The previous reviewing pass reported Review Findings (REVIEW_HAS_FINDINGS).",
    "Interpret those findings. Fix only what should be fixed now; you may defer stylistic or disputed notes.",
    "Do not commit, push, open pull requests, or start unrelated rework.",
    "End your final response with exactly one machine-readable result line:",
    "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
    "when you changed the worktree to address findings,",
    "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: <short reason>",
    "when findings remain but should not block Commit,",
    "or",
    "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
    "when on re-read there is nothing that needs fixing or deferring.",
  ].join("\n")

const uniqueFinalResultLine = (output: string): string | null => {
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
  return finalLine
}

/**
 * Parse the unique final READY_FOR_AGENT_RESULT line from a reviewing pass.
 * Returns null for missing, duplicate, non-final, or unrecognized markers.
 */
export const parseReviewResult = (
  output: string,
): ReviewingPassResult | null => {
  const finalLine = uniqueFinalResultLine(output)
  if (finalLine === null) {
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

/**
 * Parse the unique final READY_FOR_AGENT_RESULT line from an apply-findings pass.
 * Returns null for missing, duplicate, non-final, or unrecognized markers.
 */
export const parseApplyReviewResult = (
  output: string,
): ApplyReviewResult | null => {
  const finalLine = uniqueFinalResultLine(output)
  if (finalLine === null) {
    return null
  }

  if (/^READY_FOR_AGENT_RESULT:\s*REVIEW_CLEAN$/i.test(finalLine)) {
    return { _tag: "clean" }
  }

  if (/^READY_FOR_AGENT_RESULT:\s*REVIEW_FIXED$/i.test(finalLine)) {
    return { _tag: "fixed" }
  }

  const deferred = finalLine.match(
    /^READY_FOR_AGENT_RESULT:\s*REVIEW_DEFERRED\s*:\s*(.+)$/i,
  )
  if (deferred?.[1] !== undefined && deferred[1].trim() !== "") {
    return {
      _tag: "deferred",
      reason: deferred[1].trim().slice(0, 500),
    }
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

const markReviewPhase = (
  reasonCode: string,
  reasonMessage: string,
  logLabel: string,
) =>
  Effect.gen(function* () {
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
      [reasonCode, reasonMessage, now, current.stepRunId],
    )
    yield* db.notifyWorkItemsChanged(current.repositoryId)
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Failed to mark Review Step Run as ${logLabel}`, {
        error,
      }),
    ),
    Effect.asVoid,
  )

const markReviewingPhase = markReviewPhase(
  STEP_RUN_REASON.reviewReviewing,
  REVIEW_REVIEWING_MESSAGE,
  "reviewing",
)

const markApplyingFindingsPhase = markReviewPhase(
  STEP_RUN_REASON.reviewApplyingFindings,
  REVIEW_APPLYING_FINDINGS_MESSAGE,
  "applying findings",
)

const markReviewPreCommitPhase = markReviewPhase(
  STEP_RUN_REASON.reviewPreCommit,
  REVIEW_PRE_COMMIT_MESSAGE,
  "pre-commit",
)

/**
 * Production Review Lifecycle Step — reviewing pass, optional apply-findings,
 * and on FIXED a nested Pre-Commit then re-review. Continues the Implement
 * OpenCode Session. Reviewing uses the review model/variant; applying findings
 * and nested Pre-Commit fix turns use the build model/variant. Nested Pre-Commit
 * failures fail the Review Step Run (retryable), same spirit as standalone
 * Pre-Commit. At most {@link MAX_REVIEW_FIX_ROUNDS} FIXED apply rounds; further
 * findings without clean/deferred become Needs Human (not a failed Step Run).
 */
export const review = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const sessionId = yield* resolveSessionId(context)
    const timeout =
      context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.review
    const opencode = yield* Opencode
    let fixRoundsUsed = 0

    for (;;) {
      yield* markReviewingPhase

      const reviewing = yield* opencode
        .continue({
          sessionId,
          prompt: buildReviewingPrompt(),
          cwd: worktreePath,
          model: context.reviewModel,
          variant: context.reviewVariant,
          timeout,
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

      const reviewingParsed = parseReviewResult(reviewing.assistantText)
      if (reviewingParsed === null) {
        return yield* new ReviewResultError({
          workItemId: context.workItemId,
          message:
            "OpenCode did not report a unique final READY_FOR_AGENT_RESULT: REVIEW_CLEAN or REVIEW_HAS_FINDINGS",
        })
      }

      if (reviewingParsed._tag === "clean") {
        return { _tag: "clean" as const }
      }

      if (fixRoundsUsed >= MAX_REVIEW_FIX_ROUNDS) {
        return {
          _tag: "needs_human" as const,
          reason: REVIEW_FIX_LIMIT_REASON,
        }
      }

      yield* markApplyingFindingsPhase

      const applying = yield* opencode
        .continue({
          sessionId,
          prompt: buildApplyFindingsPrompt(),
          cwd: worktreePath,
          model: context.model,
          variant: context.variant,
          timeout,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReviewOpenCodeError({
                message: "OpenCode failed while applying Review Findings",
                worktreePath,
                sessionId,
                cause,
              }),
          ),
        )

      const applyParsed = parseApplyReviewResult(applying.assistantText)
      if (applyParsed === null) {
        return yield* new ReviewResultError({
          workItemId: context.workItemId,
          message:
            "OpenCode did not report a unique final READY_FOR_AGENT_RESULT: REVIEW_FIXED, REVIEW_DEFERRED: <reason>, or REVIEW_CLEAN",
        })
      }

      if (applyParsed._tag === "clean") {
        return { _tag: "clean" as const }
      }

      if (applyParsed._tag === "deferred") {
        return applyParsed
      }

      fixRoundsUsed += 1
      yield* markReviewPreCommitPhase
      yield* preCommit(context)
    }
  })
