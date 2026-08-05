/**
 * Jobs / Kanban action visibility for Work Item lifecycle controls.
 *
 * Reset deletes the Work Item, its step-run history, and its worktree. It is a
 * cancel affordance for unfinished compact cards (held Queue rows and other
 * active work) and for terminal Failed Attention cards that are obsolete after
 * a replacement Work Item exists. Complete and Abandoned history stay protected.
 *
 * Needs Human is a terminal lifecycle state but remains on the Working tab; keep
 * Reset there so operators can clear a stuck handoff when Retry is unavailable.
 * Callers pass `isNeedsHuman` / `isFailed` from domain state/status (not free-form
 * strings). Step-level FAILED on a non-terminal Work Item still shows Reset via
 * the non-terminal branch — do not denylist status === "FAILED" alone.
 */
export function canShowWorkItemResetAction(args: {
  readonly compact: boolean
  readonly isTerminal: boolean
  readonly isNeedsHuman: boolean
  readonly isFailed: boolean
}): boolean {
  if (!args.compact) return false
  if (!args.isTerminal) return true
  return args.isNeedsHuman || args.isFailed
}
