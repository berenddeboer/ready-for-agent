import {
  type OperationalLifecycleStep,
  STEP_RUN_REASON,
  type StepRunReasonCode,
} from "@ready-for-agent/lifecycle-model"
import { resultNameFromLine } from "./result-line.js"

/** Exact machine marker. Preceding nonblank text is the decision request. */
export const DECISION_NEEDED_MARKER = "DECISION_NEEDED"

export const DECISION_NEEDED_RESULT_LINE =
  "READY_FOR_AGENT_RESULT: DECISION_NEEDED"

/** Work Item failure code that distinguishes this handoff from other Needs Human parks. */
export const DECISION_NEEDED_FAILURE_CODE = "decision_needed"

const RESULT_PREFIX = /^READY_FOR_AGENT_RESULT:/i

export type DecisionNeededParse =
  | { readonly _tag: "absent" }
  | { readonly _tag: "needed"; readonly request: string }
  | { readonly _tag: "invalid"; readonly message: string }

/**
 * Family A gate. Run this before ordinary classification.
 * Absent leaves the caller's existing parser alone, including Implement's
 * session-id success when no marker is present. A present marker must be the
 * unique final result line with non-blank preceding text. Mixed, duplicate,
 * non-final, or empty requests are invalid, not success.
 */
export const parseDecisionNeeded = (output: string): DecisionNeededParse => {
  const lines = output.split("\n").map((line) => line.trim())
  const nonEmpty = lines.filter((line) => line !== "")
  const resultLines = lines.filter((line) => RESULT_PREFIX.test(line))
  const decisionLines = resultLines.filter(
    (line) => resultNameFromLine(line) === DECISION_NEEDED_MARKER,
  )
  if (decisionLines.length === 0) {
    return { _tag: "absent" }
  }
  const finalLine = nonEmpty.at(-1)
  if (
    resultLines.length !== 1 ||
    finalLine === undefined ||
    finalLine !== resultLines[0] ||
    resultNameFromLine(finalLine) !== DECISION_NEEDED_MARKER
  ) {
    return {
      _tag: "invalid",
      message:
        "DECISION_NEEDED must be the unique final READY_FOR_AGENT_RESULT line and must not be combined with another result marker",
    }
  }
  const request = nonEmpty.slice(0, -1).join("\n").trim()
  if (request === "") {
    return {
      _tag: "invalid",
      message:
        "DECISION_NEEDED requires a non-blank decision request before the result line",
    }
  }
  return { _tag: "needed", request }
}

export const decisionNeededPromptSection = (): string =>
  [
    "If a genuine scope or operator decision is unresolved, stop and ask. Do not guess, expand scope, invent an acceptance, or claim the work is finished.",
    "Write the decision request, the relevant context, the options, and a recommendation when you have one. That prose must be non-blank and must precede the marker.",
    "End with exactly one machine-readable result line and no other READY_FOR_AGENT_RESULT line:",
    DECISION_NEEDED_RESULT_LINE,
    "Use that marker only for an unresolved operator decision. Chatting in the session does not resume the harness.",
  ].join("\n")

/**
 * Classification-only discoveries route back to Implement so late Commit is
 * not retried against unfinished work. After Implement, the ordinary pipeline
 * runs fresh verification and review.
 */
export const decisionResumeTarget = (
  _originatingStep: OperationalLifecycleStep,
): "implement" => "implement"

export type DecisionNeededHandoff = {
  readonly _tag: "decision_needed"
  readonly request: string
  readonly sessionId?: string
}

export const decisionNeededHandlerOutput = (input: {
  readonly request: string
  readonly originatingStep: OperationalLifecycleStep
  readonly sessionId?: string
}): {
  readonly sessionId?: string
  readonly stepRunReasonCode: StepRunReasonCode
  readonly stepRunNote: string
  readonly stepRunReasonDetail: string
  readonly transition: {
    readonly nextState: "needs_human"
    readonly reason: string
    readonly failureCode: typeof DECISION_NEEDED_FAILURE_CODE
  }
} => ({
  ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  stepRunReasonCode: STEP_RUN_REASON.decisionNeeded,
  stepRunNote: input.request,
  stepRunReasonDetail: JSON.stringify({
    kind: "decision_needed",
    originatingStep: input.originatingStep,
    resumeTarget: decisionResumeTarget(input.originatingStep),
  }),
  transition: {
    nextState: "needs_human",
    reason: input.request,
    failureCode: DECISION_NEEDED_FAILURE_CODE,
  },
})

export const decisionResumePromptSection = (request: string): string =>
  [
    "The operator was asked for a decision in this session and has handed control back with Resume.",
    "Reconcile the scope handoff with the explicit operator decision in this session and finish the interrupted work.",
    "Supersede any earlier classification-only instruction such as CHANGES, NO_CHANGES, or REVIEW_CLEAN. A prior classification is not completion and does not authorize publication.",
    "The recorded decision request was:",
    request,
    "If that decision is still unresolved, do not guess and do not claim the work is finished. End with READY_FOR_AGENT_RESULT: DECISION_NEEDED and an updated request.",
    "After you apply the decision, finish the interrupted implementation and run appropriate verification. The harness runs a fresh review before publication; an earlier clean review does not authorize newly changed code.",
    decisionNeededPromptSection(),
  ].join("\n")

export const isDecisionNeededReason = (
  reasonCode: string | null | undefined,
): boolean => reasonCode === STEP_RUN_REASON.decisionNeeded
