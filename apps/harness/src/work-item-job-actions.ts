/**
 * Jobs / Kanban action visibility for Work Item lifecycle controls.
 *
 * Reset deletes the Work Item, its step-run history, and its worktree. It is a
 * cancel affordance for unfinished compact cards (held Queue rows and other
 * active work), not for completed/failed terminal history.
 *
 * Needs Human is a terminal lifecycle state but remains on the Working tab; keep
 * Reset there so operators can clear a stuck handoff when Retry is unavailable.
 * Callers pass `isNeedsHuman` from domain state/status (not a free-form string).
 */
export function canShowWorkItemResetAction(args: {
  readonly compact: boolean
  readonly isTerminal: boolean
  readonly isNeedsHuman: boolean
}): boolean {
  if (!args.compact) return false
  if (!args.isTerminal) return true
  return args.isNeedsHuman
}
