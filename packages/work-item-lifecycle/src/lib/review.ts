import { Effect, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentBackend,
  AgentBackendStartupTimeoutError,
  agentBackendLabel,
  formatAgentBackendStartupTimeoutMessage,
} from "@ready-for-agent/agent-backend"
import { DbService } from "@ready-for-agent/db-service"
import { CurrentStepRun } from "./agent-turn-limiter.js"
import type { LifecycleStepContext } from "./lifecycle-steps.js"
import { preCommit } from "./pre-commit.js"
import {
  classifyUnparsedResult,
  formatResultLineFailure,
  lastValidResult,
} from "./result-line.js"
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
  REVIEW_ASSESSING_RERUN_MESSAGE,
  REVIEW_PRE_COMMIT_MESSAGE,
  REVIEW_REVIEWING_MESSAGE,
  STEP_RUN_REASON,
} from "./types.js"
import { unwrapSentinelArgument } from "./unwrap-sentinel-argument.js"

/**
 * Operator-facing Review agent failure text. Retains the specific startup
 * timeout cause so Step Run diagnostics are not only the generic wrapper.
 */
export const reviewAgentFailureMessage = (
  backendLabel: string,
  action: string,
  cause: unknown,
  diagnostics?: {
    readonly model?: string
    readonly phase?: string
  },
): string => {
  if (cause instanceof AgentBackendStartupTimeoutError) {
    return formatAgentBackendStartupTimeoutMessage({
      backendLabel,
      action,
      cause,
      ...(diagnostics?.model !== undefined ? { model: diagnostics.model } : {}),
      ...(diagnostics?.phase !== undefined ? { phase: diagnostics.phase } : {}),
    })
  }
  if (cause instanceof Error && cause.message.trim() !== "") {
    return `${backendLabel} failed ${action}: ${cause.message}`
  }
  return `${backendLabel} failed ${action}`
}

/** Max build-model apply rounds per Review Step Run before Needs Human. */
export const MAX_REVIEW_FIX_ROUNDS = 5

/** Operator-visible reason when Review Fix Rounds are exhausted. */
export const REVIEW_FIX_LIMIT_REASON = `Review fix limit reached (${MAX_REVIEW_FIX_ROUNDS}); inspect the worktree or address remaining findings, then Retry.`

/** Needs Human when high-severity findings remain unresolved after apply. */
export const REVIEW_UNRESOLVED_HIGH_REASON =
  "Unresolved high-severity Review Findings require human attention."

/**
 * Needs Human when apply-findings made no worktree changes and the outcome
 * remains unknowable after one verdict-repair turn.
 */
export const REVIEW_UNPARSEABLE_APPLY_REASON =
  "Apply-findings outcome was unparseable after one verdict-repair turn; inspect the worktree or address remaining findings, then Retry."

/**
 * Needs Human when the builder leaves an original high-severity review
 * unchanged or disputes it without fixing.
 */
export const REVIEW_HIGH_UNCHANGED_REASON =
  "High-severity Review Findings were not fixed; human attention required."

/** Aggregate impact of Review Findings in one reviewing pass. */
export type ReviewSeverity = "low" | "medium" | "high"

/** Unresolved severity eligible for deferral (never high). */
export type DeferredReviewSeverity = "low" | "medium"

/** Final Review step outcome after reviewing, optional apply, and fix rounds. */
export type ReviewResult =
  | { readonly _tag: "clean" }
  | { readonly _tag: "cleared"; readonly reason: string }
  | {
      readonly _tag: "deferred"
      readonly severity: DeferredReviewSeverity
      readonly reason: string
    }
  | {
      readonly _tag: "accepted"
      readonly reason: string
      readonly deferred: {
        readonly severity: DeferredReviewSeverity
        readonly reason: string
      } | null
    }
  | { readonly _tag: "needs_human"; readonly reason: string }

/** Machine-readable outcome of the reviewing pass only. */
export type ReviewingPassResult =
  | { readonly _tag: "clean" }
  | { readonly _tag: "has_findings"; readonly severity: ReviewSeverity }

/** Machine-readable outcome of the apply-findings pass. */
export type ApplyReviewResult =
  | { readonly _tag: "fixed" }
  | {
      readonly _tag: "fixed_and_deferred"
      readonly severity: DeferredReviewSeverity
      readonly reason: string
    }
  | {
      readonly _tag: "deferred"
      readonly severity: DeferredReviewSeverity
      readonly reason: string
    }
  | { readonly _tag: "cleared"; readonly reason: string }
  | { readonly _tag: "unresolved_high"; readonly reason: string }

/** Machine-readable outcome of a Review Rerun Assessment. */
export type RerunAssessmentResult =
  | { readonly _tag: "accepted"; readonly reason: string }
  | { readonly _tag: "rerun_required"; readonly reason: string }

const SEVERITY_RUBRIC = [
  "Severity measures finding impact, not expected fix effort:",
  "low = no plausible runtime or contract impact;",
  "medium = bounded behavior or correctness impact;",
  "high = security, data-loss, major-contract, or broad/systemic impact.",
].join(" ")

/** Persist deferred severity + rationale on the completed Review Step Run. */
export const formatDeferredReviewSummary = (
  severity: DeferredReviewSeverity,
  reason: string,
): string => `${severity}: ${reason}`

/** Persist Accepted Review Outcome rationale (and any deferred remainder). */
export const formatAcceptedReviewSummary = (
  reason: string,
  deferred: {
    readonly severity: DeferredReviewSeverity
    readonly reason: string
  } | null,
): string =>
  deferred === null
    ? reason
    : `${reason} (deferred ${deferred.severity}: ${deferred.reason})`

export const buildReviewingPrompt = () =>
  [
    "Review uncommitted worktree changes.",
    "Do not edit files, commit, push, open pull requests, or apply findings in this turn.",
    SEVERITY_RUBRIC,
    "End your final response with exactly one machine-readable result line:",
    "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
    "when there are no Review Findings, or",
    "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: <low|medium|high>",
    "using the highest Review Severity among the findings.",
  ].join("\n")

export const buildReviewVerdictPrompt = () =>
  [
    "The reviewing pass immediately above has completed.",
    "Do not review again, edit files, or add explanatory prose.",
    SEVERITY_RUBRIC,
    "Classify the existing report. If it reported any Review Findings, respond exactly:",
    "READY_FOR_AGENT_RESULT: REVIEW_HAS_FINDINGS: <low|medium|high>",
    "using the highest Review Severity among those findings.",
    "Otherwise respond exactly:",
    "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
  ].join("\n")

const buildApplyFindingsPrompt = (severity: ReviewSeverity) =>
  [
    `The previous reviewing pass reported Review Findings at severity ${severity} (REVIEW_HAS_FINDINGS: ${severity}).`,
    "Interpret those findings. Fix only what should be fixed now.",
    "Low- and medium-severity findings may be deferred or cleared with a reason; high-severity findings must be fixed (with optional lower-severity deferrals) or left unresolved for a human.",
    "Do not commit, push, open pull requests, or start unrelated rework.",
    "End your final response with exactly one machine-readable result line:",
    "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
    "when you changed the worktree and no findings remain deferred,",
    "READY_FOR_AGENT_RESULT: REVIEW_FIXED_AND_DEFERRED: <low|medium>: <short reason>",
    "when you changed the worktree and also deferred remaining low/medium findings,",
    "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: <low|medium>: <short reason>",
    "when you did not change the worktree and only low/medium findings remain (defer them),",
    "READY_FOR_AGENT_RESULT: REVIEW_CLEARED: <short reason>",
    "when you reject all low/medium findings as invalid without changing the worktree,",
    "or",
    "READY_FOR_AGENT_RESULT: REVIEW_UNRESOLVED_HIGH: <short reason>",
    "when high-severity findings remain unresolved or disputed without a fix.",
  ].join("\n")

export const buildApplyFindingsVerdictPrompt = () =>
  [
    "The apply pass immediately above is complete.",
    "Do not review again, edit files, use tools, or change the worktree.",
    "Report only the machine-readable apply outcome for that already-completed pass.",
    "End your final response with exactly one of:",
    "READY_FOR_AGENT_RESULT: REVIEW_FIXED",
    "READY_FOR_AGENT_RESULT: REVIEW_FIXED_AND_DEFERRED: <low|medium>: <short reason>",
    "READY_FOR_AGENT_RESULT: REVIEW_DEFERRED: <low|medium>: <short reason>",
    "READY_FOR_AGENT_RESULT: REVIEW_CLEARED: <short reason>",
    "READY_FOR_AGENT_RESULT: REVIEW_UNRESOLVED_HIGH: <short reason>",
  ].join("\n")

export const buildRerunAssessmentPrompt = () =>
  [
    "A prior build-model pass applied low-severity Review Findings, then nested Pre-Commit ran in this Session.",
    "Using only this Session's account of those apply and Pre-Commit changes, decide whether another full reviewing pass is required.",
    "Do not edit files, commit, push, open pull requests, re-review the whole worktree, capture repository snapshots, or compute diffs.",
    "Accept without rerun only when remediation was direct, localized, and semantics-preserving relative to the low-severity findings.",
    "Require a full reviewing pass when remediation changed behavior, contracts, schemas, dependencies, security posture, concurrency, broad generated files, expanded beyond the findings, or when you are uncertain.",
    "End your final response with exactly one machine-readable result line:",
    "READY_FOR_AGENT_RESULT: REVIEW_RERUN_NOT_REQUIRED: <short reason>",
    "when the remediation may advance without another reviewing pass, or",
    "READY_FOR_AGENT_RESULT: REVIEW_RERUN_REQUIRED: <short reason>",
    "when a full reviewing pass is required.",
  ].join("\n")

const REVIEWING_RESULT_NAMES = new Set(["REVIEW_CLEAN", "REVIEW_HAS_FINDINGS"])

const APPLY_RESULT_NAMES = new Set([
  "REVIEW_FIXED",
  "REVIEW_FIXED_AND_DEFERRED",
  "REVIEW_DEFERRED",
  "REVIEW_CLEARED",
  "REVIEW_UNRESOLVED_HIGH",
])

const HARNESS_ARTIFACT_PATHSPEC = ":(exclude).ready-for-agent"

const parseSeverity = (raw: string): ReviewSeverity | null => {
  const value = unwrapSentinelArgument(raw).toLowerCase()
  if (value === "low" || value === "medium" || value === "high") {
    return value
  }
  return null
}

const parseDeferredSeverity = (raw: string): DeferredReviewSeverity | null => {
  const severity = parseSeverity(raw)
  if (severity === "low" || severity === "medium") {
    return severity
  }
  return null
}

const boundReason = (reason: string): string =>
  unwrapSentinelArgument(reason).slice(0, 500)

const tryParseReviewLine = (line: string): ReviewingPassResult | null => {
  if (/^READY_FOR_AGENT_RESULT:\s*REVIEW_CLEAN$/i.test(line)) {
    return { _tag: "clean" }
  }

  const hasFindings = line.match(
    /^READY_FOR_AGENT_RESULT:\s*REVIEW_HAS_FINDINGS\s*:\s*(.+)$/i,
  )
  if (hasFindings?.[1] !== undefined) {
    const severity = parseSeverity(hasFindings[1])
    if (severity !== null) {
      return { _tag: "has_findings", severity }
    }
  }

  return null
}

/**
 * Parse the last valid READY_FOR_AGENT_RESULT marker from a reviewing pass,
 * tolerating explanatory prose and other non-matching candidate lines.
 * Returns null only when no candidate line parses to a known marker.
 */
export const parseReviewResult = (output: string): ReviewingPassResult | null =>
  lastValidResult(output, tryParseReviewLine)

const tryParseApplyReviewLine = (line: string): ApplyReviewResult | null => {
  if (/^READY_FOR_AGENT_RESULT:\s*REVIEW_FIXED$/i.test(line)) {
    return { _tag: "fixed" }
  }

  const fixedAndDeferred = line.match(
    /^READY_FOR_AGENT_RESULT:\s*REVIEW_FIXED_AND_DEFERRED\s*:\s*([^:]+)\s*:\s*(.+)$/i,
  )
  if (
    fixedAndDeferred?.[1] !== undefined &&
    fixedAndDeferred[2] !== undefined &&
    fixedAndDeferred[2].trim() !== ""
  ) {
    const severity = parseDeferredSeverity(fixedAndDeferred[1])
    if (severity !== null) {
      return {
        _tag: "fixed_and_deferred",
        severity,
        reason: boundReason(fixedAndDeferred[2]),
      }
    }
  }

  const deferred = line.match(
    /^READY_FOR_AGENT_RESULT:\s*REVIEW_DEFERRED\s*:\s*([^:]+)\s*:\s*(.+)$/i,
  )
  if (
    deferred?.[1] !== undefined &&
    deferred[2] !== undefined &&
    deferred[2].trim() !== ""
  ) {
    const severity = parseDeferredSeverity(deferred[1])
    if (severity !== null) {
      return {
        _tag: "deferred",
        severity,
        reason: boundReason(deferred[2]),
      }
    }
  }

  const cleared = line.match(
    /^READY_FOR_AGENT_RESULT:\s*REVIEW_CLEARED\s*:\s*(.+)$/i,
  )
  if (cleared?.[1] !== undefined && cleared[1].trim() !== "") {
    return {
      _tag: "cleared",
      reason: boundReason(cleared[1]),
    }
  }

  const unresolvedHigh = line.match(
    /^READY_FOR_AGENT_RESULT:\s*REVIEW_UNRESOLVED_HIGH\s*:\s*(.+)$/i,
  )
  if (unresolvedHigh?.[1] !== undefined && unresolvedHigh[1].trim() !== "") {
    return {
      _tag: "unresolved_high",
      reason: boundReason(unresolvedHigh[1]),
    }
  }

  return null
}

/**
 * Parse the last valid READY_FOR_AGENT_RESULT marker from an apply-findings
 * pass, tolerating explanatory prose and other non-matching candidate lines.
 * Returns null only when no candidate line parses to a known marker.
 */
export const parseApplyReviewResult = (
  output: string,
): ApplyReviewResult | null => lastValidResult(output, tryParseApplyReviewLine)

const tryParseRerunAssessmentLine = (
  line: string,
): RerunAssessmentResult | null => {
  const notRequired = line.match(
    /^READY_FOR_AGENT_RESULT:\s*REVIEW_RERUN_NOT_REQUIRED\s*:\s*(.+)$/i,
  )
  if (notRequired?.[1] !== undefined && notRequired[1].trim() !== "") {
    return {
      _tag: "accepted",
      reason: boundReason(notRequired[1]),
    }
  }

  const required = line.match(
    /^READY_FOR_AGENT_RESULT:\s*REVIEW_RERUN_REQUIRED\s*:\s*(.+)$/i,
  )
  if (required?.[1] !== undefined && required[1].trim() !== "") {
    return {
      _tag: "rerun_required",
      reason: boundReason(required[1]),
    }
  }

  return null
}

/**
 * Parse the last valid READY_FOR_AGENT_RESULT marker from a Review Rerun
 * Assessment, tolerating explanatory prose and other non-matching candidate
 * lines. Returns null only when no candidate line parses to a known marker.
 */
export const parseRerunAssessmentResult = (
  output: string,
): RerunAssessmentResult | null =>
  lastValidResult(output, tryParseRerunAssessmentLine)

const runGitInWorktree = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const command = ChildProcess.make("git", args, {
      cwd,
      stdin: "ignore",
    })

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command)
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.decodeText(handle.stdout).pipe(Stream.mkString),
            Stream.decodeText(handle.stderr).pipe(Stream.mkString),
          ],
          { concurrency: 3 },
        )
        return {
          exitCode: Number(exitCode),
          stdout,
          stderr,
        }
      }),
    )
  })

const worktreeFingerprint = (worktreePath: string) =>
  Effect.gen(function* () {
    const status = yield* runGitInWorktree(worktreePath, [
      "status",
      "--porcelain",
      "--",
      ".",
      HARNESS_ARTIFACT_PATHSPEC,
    ])
    if (status.exitCode !== 0) {
      return null
    }
    const diff = yield* runGitInWorktree(worktreePath, [
      "diff",
      "HEAD",
      "--",
      ".",
      HARNESS_ARTIFACT_PATHSPEC,
    ])
    // Plain `git diff` exits 0 with a patch. `--exit-code` / `--quiet` and
    // some configs exit 1 when a diff exists. Both are usable snapshots.
    if (diff.exitCode !== 0 && diff.exitCode !== 1) {
      return null
    }
    const head = yield* runGitInWorktree(worktreePath, ["rev-parse", "HEAD"])
    if (head.exitCode !== 0) {
      return null
    }
    return [status.stdout, diff.stdout, head.stdout.trim()].join("\n")
  }).pipe(Effect.orElseSucceed(() => null))

const applyChangedWorktree = (
  before: string | null,
  after: string | null,
): boolean => before !== null && after !== null && before !== after

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

const markAssessingRerunPhase = markReviewPhase(
  STEP_RUN_REASON.reviewAssessingRerun,
  REVIEW_ASSESSING_RERUN_MESSAGE,
  "assessing rerun",
)

/**
 * Production Review Lifecycle Step — reviewing pass, optional apply-findings,
 * and on changed work a nested Pre-Commit then either a Review Rerun Assessment
 * (low severity) or a mandatory full reviewing pass (medium/high). Continues the
 * Implement OpenCode Session. Reviewing uses the review model/variant; applying
 * findings, nested Pre-Commit fix turns, and rerun assessments use the build
 * model/variant. A missing or malformed reviewing/apply marker gets one
 * no-tools verdict-repair turn. An unparseable apply that changed the worktree
 * counts as a Review Fix Round and revalidates; an unparseable unchanged apply
 * is Needs Human. Nested Pre-Commit failures fail the Review Step Run (retryable),
 * same spirit as standalone Pre-Commit. At most {@link MAX_REVIEW_FIX_ROUNDS}
 * changed apply rounds; assessment and reviewing turns do not independently
 * consume rounds. Further findings without clean/deferred/cleared/accepted
 * become Needs Human (not a failed Step Run).
 */
export const review = (context: LifecycleStepContext) =>
  Effect.gen(function* () {
    const worktreePath = yield* resolveWorktreePath(context)
    const sessionId = yield* resolveSessionId(context)
    const timeout =
      context.maxDuration ?? DEFAULT_LIFECYCLE_MAX_DURATIONS.review
    const agentBackend = yield* AgentBackend
    let fixRoundsUsed = 0

    for (;;) {
      yield* markReviewingPhase

      const reviewing = yield* agentBackend
        .continueTurn({
          sessionId,
          prompt: buildReviewingPrompt(),
          cwd: worktreePath,
          model: context.reviewModel,
          thinkingLevel: context.reviewThinkingLevel,
          timeout,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReviewOpenCodeError({
                message: reviewAgentFailureMessage(
                  agentBackendLabel(context.agentBackend),
                  "to review the Work Item",
                  cause,
                  {
                    model: context.reviewModel,
                    phase: STEP_RUN_REASON.reviewReviewing,
                  },
                ),
                worktreePath,
                sessionId,
                cause,
              }),
          ),
        )

      let reviewingOutput = reviewing.assistantText
      let reviewingParsed = parseReviewResult(reviewingOutput)
      let reviewingCorrectionUsed = false
      if (reviewingParsed === null) {
        reviewingCorrectionUsed = true
        const verdict = yield* agentBackend
          .continueTurn({
            sessionId,
            prompt: buildReviewVerdictPrompt(),
            cwd: worktreePath,
            model: context.reviewModel,
            thinkingLevel: context.reviewThinkingLevel,
            timeout,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ReviewOpenCodeError({
                  message: reviewAgentFailureMessage(
                    agentBackendLabel(context.agentBackend),
                    "to report the Review verdict",
                    cause,
                    {
                      model: context.reviewModel,
                      phase: STEP_RUN_REASON.reviewReviewing,
                    },
                  ),
                  worktreePath,
                  sessionId,
                  cause,
                }),
            ),
          )
        reviewingOutput = verdict.assistantText
        reviewingParsed = parseReviewResult(reviewingOutput)
      }

      if (reviewingParsed === null) {
        const failure = classifyUnparsedResult(
          reviewingOutput,
          REVIEWING_RESULT_NAMES,
        )
        yield* Effect.logInfo("Review reviewing verdict unparseable", {
          workItemId: context.workItemId,
          agentBackend: context.agentBackend,
          model: context.reviewModel,
          boundary: "reviewing",
          correctionTurnUsed: reviewingCorrectionUsed,
          fallbackPath: "none",
          failureKind: failure.kind,
          lastCandidate: failure.lastCandidate,
        })
        return yield* new ReviewResultError({
          workItemId: context.workItemId,
          message: `${agentBackendLabel(context.agentBackend)} did not report a valid READY_FOR_AGENT_RESULT: REVIEW_CLEAN or REVIEW_HAS_FINDINGS: <low|medium|high> (${formatResultLineFailure(failure.kind, failure.lastCandidate)})`,
        })
      }

      if (reviewingParsed._tag === "clean") {
        return { _tag: "clean" as const }
      }

      const originalSeverity = reviewingParsed.severity

      if (fixRoundsUsed >= MAX_REVIEW_FIX_ROUNDS) {
        return {
          _tag: "needs_human" as const,
          reason: REVIEW_FIX_LIMIT_REASON,
        }
      }

      yield* markApplyingFindingsPhase

      const fingerprintBefore = yield* worktreeFingerprint(worktreePath)

      const applying = yield* agentBackend
        .continueTurn({
          sessionId,
          prompt: buildApplyFindingsPrompt(originalSeverity),
          cwd: worktreePath,
          model: context.model,
          thinkingLevel: context.thinkingLevel,
          timeout,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReviewOpenCodeError({
                message: reviewAgentFailureMessage(
                  agentBackendLabel(context.agentBackend),
                  "while applying Review Findings",
                  cause,
                  {
                    model: context.model,
                    phase: STEP_RUN_REASON.reviewApplyingFindings,
                  },
                ),
                worktreePath,
                sessionId,
                cause,
              }),
          ),
        )

      const fingerprintAfter = yield* worktreeFingerprint(worktreePath)
      const worktreeChanged = applyChangedWorktree(
        fingerprintBefore,
        fingerprintAfter,
      )

      let applyOutput = applying.assistantText
      let applyParsed = parseApplyReviewResult(applyOutput)
      let applyCorrectionUsed = false
      if (applyParsed === null) {
        applyCorrectionUsed = true
        const repair = yield* agentBackend
          .continueTurn({
            sessionId,
            prompt: buildApplyFindingsVerdictPrompt(),
            cwd: worktreePath,
            model: context.model,
            thinkingLevel: context.thinkingLevel,
            timeout,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ReviewOpenCodeError({
                  message: reviewAgentFailureMessage(
                    agentBackendLabel(context.agentBackend),
                    "to report the apply-findings verdict",
                    cause,
                    {
                      model: context.model,
                      phase: STEP_RUN_REASON.reviewApplyingFindings,
                    },
                  ),
                  worktreePath,
                  sessionId,
                  cause,
                }),
            ),
          )
        applyOutput = repair.assistantText
        applyParsed = parseApplyReviewResult(applyOutput)
      }

      if (applyParsed === null) {
        const failure = classifyUnparsedResult(applyOutput, APPLY_RESULT_NAMES)
        const fallbackPath = worktreeChanged ? "revalidate" : "needs_human"
        yield* Effect.logInfo(
          "Review apply-findings verdict unparseable; using conservative fallback",
          {
            workItemId: context.workItemId,
            agentBackend: context.agentBackend,
            model: context.model,
            boundary: "apply_findings",
            correctionTurnUsed: applyCorrectionUsed,
            fallbackPath,
            worktreeChanged,
            failureKind: failure.kind,
            lastCandidate: failure.lastCandidate,
          },
        )
        if (!worktreeChanged) {
          const detail = formatResultLineFailure(
            failure.kind,
            failure.lastCandidate,
          )
          return {
            _tag: "needs_human" as const,
            reason: `${REVIEW_UNPARSEABLE_APPLY_REASON} ${detail}.`,
          }
        }
        // Changed worktree with unknowable outcome: count a Fix Round and
        // revalidate via Pre-Commit plus a fresh reviewing pass.
        fixRoundsUsed += 1
        yield* markReviewPreCommitPhase
        yield* preCommit(context)
        continue
      }

      if (applyParsed._tag === "unresolved_high") {
        return {
          _tag: "needs_human" as const,
          reason:
            applyParsed.reason.trim() !== ""
              ? applyParsed.reason
              : REVIEW_UNRESOLVED_HIGH_REASON,
        }
      }

      if (applyParsed._tag === "deferred") {
        if (originalSeverity === "high") {
          return {
            _tag: "needs_human" as const,
            reason: REVIEW_HIGH_UNCHANGED_REASON,
          }
        }
        return {
          _tag: "deferred" as const,
          severity: applyParsed.severity,
          reason: applyParsed.reason,
        }
      }

      if (applyParsed._tag === "cleared") {
        if (originalSeverity === "high") {
          return {
            _tag: "needs_human" as const,
            reason: REVIEW_HIGH_UNCHANGED_REASON,
          }
        }
        return {
          _tag: "cleared" as const,
          reason: applyParsed.reason,
        }
      }

      // fixed | fixed_and_deferred — changed work: Pre-Commit then severity policy
      fixRoundsUsed += 1
      const deferredFromApply =
        applyParsed._tag === "fixed_and_deferred"
          ? {
              severity: applyParsed.severity,
              reason: applyParsed.reason,
            }
          : null

      yield* markReviewPreCommitPhase
      yield* preCommit(context)

      if (originalSeverity === "low") {
        yield* markAssessingRerunPhase
        const assessment = yield* agentBackend
          .continueTurn({
            sessionId,
            prompt: buildRerunAssessmentPrompt(),
            cwd: worktreePath,
            model: context.model,
            thinkingLevel: context.thinkingLevel,
            timeout,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ReviewOpenCodeError({
                  message: reviewAgentFailureMessage(
                    agentBackendLabel(context.agentBackend),
                    "during Review Rerun Assessment",
                    cause,
                    {
                      model: context.model,
                      phase: STEP_RUN_REASON.reviewAssessingRerun,
                    },
                  ),
                  worktreePath,
                  sessionId,
                  cause,
                }),
            ),
          )

        const assessmentParsed = parseRerunAssessmentResult(
          assessment.assistantText,
        )
        // Missing or malformed → conservative full reviewing pass
        if (assessmentParsed?._tag === "accepted") {
          return {
            _tag: "accepted" as const,
            reason: assessmentParsed.reason,
            deferred: deferredFromApply,
          }
        }
      }
      // medium/high mandatory rerun, low rerun_required, or malformed assessment
    }
  })
