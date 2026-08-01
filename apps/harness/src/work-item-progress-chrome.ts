/**
 * Shared Jobs progress chrome: lifecycle chips, status tags, PR badges.
 * Tailwind recipes from `ui.ts` (§5.1–5.2, §5.5).
 */
import type { LifecyclePipelineLaneId } from "./pipeline-lanes.js"
import { cx, ui } from "./ui.js"

export const lifecycleStepChipClassName = cx(ui.leg, ui.legDone)

export const statusBadgeBaseClassName = ui.statusTag

export const prBadgeClassName = ui.prBadge

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
      ? ui.statusTagAlarm
      : status === "COMPLETE" || status === "SUCCEEDED"
        ? ui.statusTagComplete
        : status === "ABANDONED" || status === "CANCELLED"
          ? ui.statusTagGhost
          : status === "WAITING_FOR_WORKER_SLOT" ||
              status === "WAITING_FOR_BLOCKERS"
            ? ui.statusTagHold
            : ui.statusTagPlain
  return cx(statusBadgeBaseClassName, tone)
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
    return cx(ui.leg, ui.legFail)
  }
  if (status === "RUNNING") {
    return cx(ui.leg, ui.legRun)
  }
  if (status === "SUCCEEDED" || status === "COMPLETE") {
    return cx(ui.leg, ui.legDone)
  }
  // QUEUED / unreached / other holds
  return cx(ui.leg, ui.legNext)
}

/** Alarm Work Item statuses — UI prefixes the message with ▲. */
export function isStatusMessageAlarm(status: string): boolean {
  return (
    status === "FAILED" ||
    status === "INTERRUPTED" ||
    status === "NEEDS_HUMAN" ||
    status === "NEEDS_HUMAN_REVIEW"
  )
}

/** Message line under the status tag (§5.1). Alarm statuses get ▲ in the row. */
export function statusMessageClassNameForStatus(status: string): string {
  if (isStatusMessageAlarm(status)) {
    return cx(ui.statusMessage, ui.statusMessageAlarm)
  }
  return ui.statusMessage
}
