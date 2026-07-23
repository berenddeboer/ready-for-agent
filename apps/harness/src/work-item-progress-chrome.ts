/**
 * Shared Jobs card progress chrome: lifecycle chips, status badges, PR badges.
 * Minimum type size is Tailwind `text-xs` (0.75rem) — no sub-xs rem utilities.
 */
export const jobsProgressMinTextClassName = "text-xs"

export const lifecycleStepChipClassName = `rounded bg-white px-1.5 py-1 ${jobsProgressMinTextClassName} text-slate-600 ring-1 ring-slate-200`

export const statusBadgeBaseClassName = `rounded-full px-2 py-0.5 ${jobsProgressMinTextClassName} font-bold tracking-wide uppercase`

export const prBadgeClassName = `rounded-full bg-slate-200 px-2 py-0.5 ${jobsProgressMinTextClassName} font-bold tracking-wide text-slate-700 uppercase hover:bg-slate-300 hover:underline`

export function statusBadgeClassNameForStatus(status: string): string {
  const tone =
    status === "FAILED" || status === "INTERRUPTED"
      ? "bg-red-100 text-red-700"
      : status === "COMPLETE" || status === "SUCCEEDED"
        ? "bg-green-100 text-green-700"
        : status === "ABANDONED" || status === "CANCELLED"
          ? "bg-slate-200 text-slate-600"
          : status === "NEEDS_HUMAN" || status === "NEEDS_HUMAN_REVIEW"
            ? "bg-amber-100 text-amber-800"
            : status === "WAITING_FOR_WORKER_SLOT"
              ? "bg-violet-100 text-violet-800"
              : "bg-blue-100 text-blue-700"
  return `${statusBadgeBaseClassName} ${tone}`
}
