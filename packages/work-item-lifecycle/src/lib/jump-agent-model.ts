import { STEP_RUN_REASON } from "@ready-for-agent/lifecycle-model"
import type { AgentModelSelection } from "./resolve-agent-models.js"

/** Agent Model Jump must pin on Interactive Session Continuation. */
export type JumpAgentModel = {
  readonly model: string
  readonly thinkingLevel: string | null
}

const nonEmpty = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== ""

/**
 * Choose the Agent Model a live attach must pin so it cannot overwrite the
 * Session with an ambient default. A running Review Step Run uses the review
 * selection except while applying findings, assessing a rerun, or re-running
 * Pre-Commit, which use the build selection. A Review Work Item with no
 * running Step Run uses review; every other step and state uses build.
 */
const reviewPhaseUsesBuildModel = (
  reason: string | null | undefined,
): boolean =>
  reason === STEP_RUN_REASON.reviewApplyingFindings ||
  reason === STEP_RUN_REASON.reviewAssessingRerun ||
  reason === STEP_RUN_REASON.reviewPreCommit

export const selectJumpAgentModel = (input: {
  readonly runningStep: string | null
  readonly runningStepReason?: string | null
  readonly workItemState: string
  readonly selection: AgentModelSelection | null
}): JumpAgentModel | null => {
  const selection = input.selection
  if (selection === null) {
    return null
  }
  const applyingBuildModelReview =
    input.runningStep === "review" &&
    reviewPhaseUsesBuildModel(input.runningStepReason)
  const useReview =
    !applyingBuildModelReview &&
    (input.runningStep === "review" ||
      (input.runningStep === null && input.workItemState === "review"))
  if (useReview) {
    return nonEmpty(selection.reviewModel)
      ? {
          model: selection.reviewModel,
          thinkingLevel: selection.reviewThinkingLevel,
        }
      : null
  }
  return nonEmpty(selection.model)
    ? {
        model: selection.model,
        thinkingLevel: selection.thinkingLevel,
      }
    : null
}
