/**
 * Productive Step Run time excludes OpenCode session-slot waits so max duration
 * and visibility leases measure work, not queueing for a permit.
 */

export type StepRunProductiveTimeRow = {
  readonly started_at: number | null
  readonly session_wait_ms: number | null
  readonly session_wait_started_at: number | null
}

export const computeProductiveElapsedMs = (
  row: StepRunProductiveTimeRow,
  nowMs: number,
): number => {
  if (row.started_at === null) {
    return 0
  }
  const completedWaitMs = Math.max(0, row.session_wait_ms ?? 0)
  const openWaitMs =
    row.session_wait_started_at === null
      ? 0
      : Math.max(0, nowMs - row.session_wait_started_at)
  return Math.max(0, nowMs - row.started_at - completedWaitMs - openWaitMs)
}
