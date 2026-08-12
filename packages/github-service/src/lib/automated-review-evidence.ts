/**
 * Harness-owned automated-review evidence for Status Check Handoffs.
 *
 * Positive evidence follows ADR 0027 / issue #374: an executed recognized
 * reviewer job or step, or a comment/review from a recognized automated
 * reviewer. Workflow or job names alone (including names containing "review")
 * and skipped or zero-step reviewers are not positive evidence.
 *
 * Visibly incomplete Automated Review Output is classified from the latest
 * correlated recognized-reviewer comment body (ADR 0027 amendment / #971).
 */

/** Telemetry token for green-only fast-path handoffs with no review evidence. */
export const GREEN_NO_REVIEW_EVIDENCE_REASON =
  "green-no-review-evidence" as const

/**
 * Stable incomplete-signature id for finished-banner + unchecked substantive
 * progress task (and/or missing synthesis). Scoped with work item, head SHA,
 * and workflow run for the one-retry early circuit breaker.
 */
export const INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE =
  "finished_banner_unchecked_substantive_task" as const

/**
 * Structured observation of whether a green Status Check Handoff has positive
 * or ambiguous automated-review evidence that still needs Investigate, or
 * harness-classifiable incomplete Automated Review Output.
 */
export type AutomatedReviewEvidenceObservation =
  | {
      readonly _tag: "none"
      readonly reason: typeof GREEN_NO_REVIEW_EVIDENCE_REASON
    }
  | {
      readonly _tag: "positive"
      readonly kind:
        | "executed_reviewer_job"
        | "review_comment"
        | "pull_request_review"
      readonly detail: string
    }
  | {
      readonly _tag: "incomplete"
      readonly signature: typeof INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE
      /** Workflow run id from the comment job link and/or Actions job, when known. */
      readonly workflowRunId: number | null
      /** Operator-facing workflow/check identity (not an implement Agent Model). */
      readonly workflowName: string | null
      readonly detail: string
    }
  | {
      readonly _tag: "ambiguous"
      readonly reason: string
    }

/**
 * Product-specific markers for recognized automated reviewers.
 * Intentionally does not match ordinary CI names that merely contain "review"
 * (for example `PR Review/main`).
 */
const RECOGNIZED_REVIEWER_NAME_MARKERS: readonly RegExp[] = [
  /claude[\s_-]*code[\s_-]*review/i,
  /claude[\s_-]*review/i,
  /\bcoderabbit\b/i,
  /\bcursor[\s_-]*bugbot\b/i,
  /\bcopilot[\s_-]*(?:code[\s_-]*)?review/i,
  /\bgemini[\s_-]*code[\s_-]*assist\b/i,
  /\bgraphite[\s_-]*(?:ai[\s_-]*)?reviewer\b/i,
]

/**
 * Known automated-review bot logins (issue comments, review comments, reviews).
 * Generic bots (github-actions, dependabot, renovate) are not review evidence.
 */
const RECOGNIZED_REVIEWER_LOGINS = new Set(
  [
    "claude",
    "claude[bot]",
    "coderabbitai",
    "coderabbitai[bot]",
    "coderabbit",
    "copilot-pull-request-reviewer",
    "copilot-pull-request-reviewer[bot]",
    "cursor",
    "cursor[bot]",
    "gemini-code-assist",
    "gemini-code-assist[bot]",
    "graphite-app",
    "graphite-app[bot]",
  ].map((login) => login.toLowerCase()),
)

/** True when a check, workflow, or job name identifies a known automated reviewer. */
export const isRecognizedAutomatedReviewerName = (name: string): boolean => {
  const trimmed = name.trim()
  if (trimmed === "") {
    return false
  }
  return RECOGNIZED_REVIEWER_NAME_MARKERS.some((marker) => marker.test(trimmed))
}

/** True when a GitHub login is a known automated-review bot. */
export const isRecognizedAutomatedReviewerLogin = (login: string): boolean => {
  const normalized = login.trim().toLowerCase()
  return normalized !== "" && RECOGNIZED_REVIEWER_LOGINS.has(normalized)
}

export type ActionsJobStepEvidence = {
  readonly status?: unknown
  readonly conclusion?: unknown
}

export type ActionsJobExecutionEvidence = {
  readonly conclusion?: unknown
  readonly steps?: readonly ActionsJobStepEvidence[] | null
}

const normalizeToken = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim() === "") {
    return null
  }
  return value.trim().toUpperCase()
}

/**
 * Inspection of a recognized reviewer's Actions job steps.
 *
 * - `executed`: at least one non-skipped step ran (positive review evidence).
 * - `not_executed`: explicit skipped-style conclusion with empty steps, or all
 *   steps skipped (not positive evidence).
 * - `steps_unavailable`: empty/missing steps without an explicit skip
 *   conclusion (including null/missing conclusion), or non-skipped conclusion
 *   with no inspectable steps; treat as ambiguous rather than green-no-review.
 */
export type ReviewerJobStepInspection =
  | { readonly _tag: "executed" }
  | { readonly _tag: "not_executed" }
  | { readonly _tag: "steps_unavailable" }

/** Explicit GitHub conclusions that mean the job did not run review work. */
const isExplicitSkippedStyleConclusion = (conclusion: string | null): boolean =>
  conclusion === "SKIPPED" ||
  conclusion === "CANCELLED" ||
  conclusion === "NEUTRAL"

/**
 * Classify whether a recognized reviewer job executed review steps.
 * Empty steps prove a no-op only under an explicit skipped-style conclusion.
 * Missing conclusion or non-skipped conclusion without inspectable steps is an
 * observability gap. Non-empty steps only count as not_executed when every
 * step is explicitly SKIPPED; any null/missing step conclusion is unavailable.
 */
export const inspectReviewerJobSteps = (
  job: ActionsJobExecutionEvidence,
): ReviewerJobStepInspection => {
  const steps = job.steps ?? []
  if (steps.length === 0) {
    return isExplicitSkippedStyleConclusion(normalizeToken(job.conclusion))
      ? { _tag: "not_executed" }
      : { _tag: "steps_unavailable" }
  }
  let hasExecutedStep = false
  let hasUninspectableStep = false
  for (const step of steps) {
    const conclusion = normalizeToken(step.conclusion)
    if (conclusion === null) {
      hasUninspectableStep = true
      continue
    }
    if (conclusion !== "SKIPPED") {
      hasExecutedStep = true
    }
  }
  if (hasExecutedStep) {
    return { _tag: "executed" }
  }
  if (hasUninspectableStep) {
    return { _tag: "steps_unavailable" }
  }
  // Every step is explicitly SKIPPED.
  return { _tag: "not_executed" }
}

/**
 * True when an Actions job ran at least one non-skipped step.
 * Prefer {@link inspectReviewerJobSteps} when empty-step ambiguity matters.
 */
export const jobHasExecutedReviewerSteps = (
  job: ActionsJobExecutionEvidence,
): boolean => inspectReviewerJobSteps(job)._tag === "executed"

export type AutomatedReviewEvidenceCheck = {
  readonly externalId: string
  readonly name: string
}

/** Claude / recognized-reviewer finished banner (terminal attempt claimed done). */
const FINISHED_BANNER_PATTERN =
  /(?:\*\*)?Claude finished\b|\bfinished\s+@[\w-]+(?:\[bot\])?'s\s+task\b/i

/**
 * Unchecked substantive progress tasks that mean the review never synthesized
 * or posted findings (strong incompleteness evidence when paired with a
 * finished banner).
 */
const UNCHECKED_SUBSTANTIVE_TASK_PATTERN =
  /-\s*\[\s*\]\s*(?:Aggregate findings(?:\s+and\s+post\s+review)?|Synthesize findings|Post review|Run two-axis review)\b/i

/** Any unchecked Markdown task (secondary signal with finished banner). */
const UNCHECKED_MARKDOWN_TASK_PATTERN = /-\s*\[\s*\]\s+\S/

/**
 * Heuristic markers of a completed review synthesis section. Absence with a
 * finished banner and unchecked progress is strong incompleteness evidence.
 */
const FINAL_SYNTHESIS_PATTERN =
  /(?:##\s*(?:Findings|Summary|Review|Verdict)|Standards?\s+review|Spec\s+review|overall\s+assessment|READY_FOR_AGENT_RESULT)/i

/**
 * Classification of a recognized automated-reviewer comment body.
 * Discriminated so incomplete always carries a stable signature.
 */
export type IncompleteAutomatedReviewClassification =
  | { readonly _tag: "complete" }
  | {
      readonly _tag: "incomplete"
      readonly signature: typeof INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE
    }

/**
 * Classify whether a recognized automated-reviewer comment body is a present
 * but visibly incomplete Automated Review Output.
 *
 * Strong pattern: finished banner + unchecked Aggregate-style substantive task
 * and/or finished banner + unchecked progress without final synthesis.
 * Arbitrary Markdown checkboxes in unrelated comments are not considered.
 */
export const classifyIncompleteAutomatedReviewOutput = (
  body: string,
): IncompleteAutomatedReviewClassification => {
  if (body.trim() === "") {
    return { _tag: "complete" }
  }
  const hasFinishedBanner = FINISHED_BANNER_PATTERN.test(body)
  if (!hasFinishedBanner) {
    return { _tag: "complete" }
  }
  if (UNCHECKED_SUBSTANTIVE_TASK_PATTERN.test(body)) {
    return {
      _tag: "incomplete",
      signature: INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE,
    }
  }
  if (
    UNCHECKED_MARKDOWN_TASK_PATTERN.test(body) &&
    !FINAL_SYNTHESIS_PATTERN.test(body)
  ) {
    return {
      _tag: "incomplete",
      signature: INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE,
    }
  }
  return { _tag: "complete" }
}

/**
 * Extract a GitHub Actions workflow run id from a review comment body
 * (e.g. `.../actions/runs/31549139160`).
 */
export const extractWorkflowRunIdFromReviewComment = (
  body: string,
): number | null => {
  const match = body.match(/actions\/runs\/(\d+)/i)
  if (match?.[1] === undefined) {
    return null
  }
  const id = Number(match[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * Operator-facing workflow identity from a check name such as
 * `Claude Code Review/claude-review` → `Claude Code Review`.
 */
export const workflowNameFromCheckName = (name: string): string => {
  const trimmed = name.trim()
  if (trimmed === "") {
    return trimmed
  }
  const slash = trimmed.indexOf("/")
  return slash > 0 ? trimmed.slice(0, slash).trim() : trimmed
}
