/**
 * Shared Jobs progress chrome: lifecycle chips, status tags, PR badges.
 * Interchange component classes (§5.1–5.2, §5.5). Board density floors at
 * 0.56rem mono; prefer CSS classes over Tailwind rem utilities.
 */
import type { LifecyclePipelineLaneId } from "./pipeline-lanes.js"

export const lifecycleStepChipClassName = "leg leg--done"

export const statusBadgeBaseClassName = "status-tag"

export const prBadgeClassName = "pr-badge"

const LANE_STYLE: Record<
  LifecyclePipelineLaneId,
  { readonly lane: string; readonly on: string }
> = {
  build: { lane: "var(--lane-build)", on: "var(--lane-build-ink)" },
  review: { lane: "var(--lane-review)", on: "var(--lane-review-ink)" },
  pr: { lane: "var(--lane-pr)", on: "var(--lane-pr-ink)" },
}

/**
 * CSS custom properties for a lifecycle lane's chip / summary fill pair.
 * Used for running journey legs and lane-colored collapsed summaries.
 */
export function lifecycleLaneCssVars(lane: LifecyclePipelineLaneId): {
  readonly "--leg-lane": string
  readonly "--leg-on": string
} {
  const style = LANE_STYLE[lane]
  return { "--leg-lane": style.lane, "--leg-on": style.on }
}

/**
 * Badge tone by operator-visible status (§5.1).
 * Hold statuses share dashed treatment; alarms share Attention fill.
 */
export function statusBadgeClassNameForStatus(status: string): string {
  const tone =
    status === "FAILED" ||
    status === "INTERRUPTED" ||
    status === "NEEDS_HUMAN" ||
    status === "NEEDS_HUMAN_REVIEW"
      ? "status-tag--alarm"
      : status === "COMPLETE" || status === "SUCCEEDED"
        ? "status-tag--complete"
        : status === "ABANDONED" || status === "CANCELLED"
          ? "status-tag--ghost"
          : status === "WAITING_FOR_WORKER_SLOT" ||
              status === "WAITING_FOR_BLOCKERS"
            ? "status-tag--hold"
            : "status-tag--plain"
  return `${statusBadgeBaseClassName} ${tone}`
}

/**
 * Journey-leg chip class for a step status (§5.2 board treatment).
 * Running chips also need `lifecycleLaneCssVars` for current-lane fill.
 * Needs-human steps share the Attention fill with failures (status tags
 * already use alarm); they are not lane-colored "in progress" fills.
 * DECIDE_PR_MERGE still links externally via call-site markup.
 */
export function lifecycleStepChipClassNameForStatus(status: string): string {
  if (
    status === "FAILED" ||
    status === "INTERRUPTED" ||
    status === "NEEDS_HUMAN" ||
    status === "NEEDS_HUMAN_REVIEW"
  ) {
    return "leg leg--fail"
  }
  if (status === "RUNNING") {
    return "leg leg--run"
  }
  if (status === "SUCCEEDED" || status === "COMPLETE") {
    return "leg leg--done"
  }
  // QUEUED / unreached / other holds
  return "leg leg--next"
}

/** Message line under the status tag (§5.1). Alarm statuses get ▲ via CSS. */
export function statusMessageClassNameForStatus(status: string): string {
  if (
    status === "FAILED" ||
    status === "INTERRUPTED" ||
    status === "NEEDS_HUMAN" ||
    status === "NEEDS_HUMAN_REVIEW"
  ) {
    return "status-message status-message--alarm"
  }
  return "status-message"
}
