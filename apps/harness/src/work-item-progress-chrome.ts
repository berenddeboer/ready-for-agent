/**
 * Shared Jobs card progress chrome: lifecycle chips, status badges, PR badges.
 * Minimum type size is Tailwind `text-xs` (0.75rem) — no sub-xs rem utilities.
 */
export const jobsProgressMinTextClassName = "text-xs"

export const lifecycleStepChipClassName = `border border-rule-2 bg-paper px-1.5 py-1 ${jobsProgressMinTextClassName} text-ink-2`

export const statusBadgeBaseClassName = `inline-flex items-center border px-2 py-0.5 ${jobsProgressMinTextClassName} font-bold tracking-wide uppercase`

export const prBadgeClassName = `stamp border-rule-2 ${jobsProgressMinTextClassName} text-ink-2 no-underline hover:border-oxblood hover:text-oxblood hover:underline`

/**
 * Badge tone by operator-visible status.
 * Waiting for blockers (Queue hold) is teal — distinct from violet Waiting for
 * Worker Slot and from bare Step Run / Agent Turn Queued (oxblood default).
 */
export function statusBadgeClassNameForStatus(status: string): string {
  const tone =
    status === "FAILED" || status === "INTERRUPTED"
      ? "border-oxblood/40 bg-oxblood-wash text-oxblood"
      : status === "COMPLETE" || status === "SUCCEEDED"
        ? "border-olive/40 bg-olive-wash text-olive"
        : status === "ABANDONED" || status === "CANCELLED"
          ? "border-rule-2 bg-paper-2 text-ink-faint"
          : status === "NEEDS_HUMAN" || status === "NEEDS_HUMAN_REVIEW"
            ? "border-sepia/40 bg-amber-wash text-sepia"
            : status === "WAITING_FOR_WORKER_SLOT"
              ? "border-violet-300 bg-violet-wash text-violet-800"
              : status === "WAITING_FOR_BLOCKERS"
                ? "border-teal/40 bg-teal-wash text-teal"
                : "border-oxblood/30 bg-oxblood-wash text-oxblood"
  return `${statusBadgeBaseClassName} ${tone}`
}

/** Message line tone under the status badge (wait holds vs failure copy). */
export function statusMessageClassNameForStatus(status: string): string {
  if (status === "WAITING_FOR_WORKER_SLOT") return "text-violet-800"
  if (status === "WAITING_FOR_BLOCKERS") return "text-teal"
  return "text-oxblood-deep"
}
