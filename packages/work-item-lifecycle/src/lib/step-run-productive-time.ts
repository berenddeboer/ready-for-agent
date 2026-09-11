/**
 * Productive Step Run time excludes OpenCode session-slot waits so max duration
 * and visibility leases measure work, not queueing for a permit.
 */

export type StepRunProductiveTimeRow = {
  readonly started_at: number | null
  readonly session_wait_ms: number | null
  readonly session_wait_started_at: number | null
}

export type ReviewProgressTimeRow = StepRunProductiveTimeRow & {
  readonly progress_checkpoint_at: number | null
  readonly progress_checkpoint_session_wait_ms: number | null
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

/**
 * Review's no-progress clock: productive time since the last Review Progress
 * Checkpoint, or since start when none has completed. Subtracts only Agent
 * Turn admission waiting accrued after that origin.
 */
export const computeReviewProgressElapsedMs = (
  row: ReviewProgressTimeRow,
  nowMs: number,
): number => {
  if (row.progress_checkpoint_at === null) {
    return computeProductiveElapsedMs(row, nowMs)
  }
  const origin = row.progress_checkpoint_at
  const snapshot = Math.max(0, row.progress_checkpoint_session_wait_ms ?? 0)
  const completedWaitSince = Math.max(
    0,
    Math.max(0, row.session_wait_ms ?? 0) - snapshot,
  )
  const waitStartedAt = row.session_wait_started_at
  const openWaitStart =
    waitStartedAt === null || waitStartedAt < origin ? origin : waitStartedAt
  const openWaitMs =
    waitStartedAt === null ? 0 : Math.max(0, nowMs - openWaitStart)
  return Math.max(0, nowMs - origin - completedWaitSince - openWaitMs)
}

export const computeStepTimeoutElapsedMs = (
  step: string,
  row: ReviewProgressTimeRow,
  nowMs: number,
): number =>
  step === "review"
    ? computeReviewProgressElapsedMs(row, nowMs)
    : computeProductiveElapsedMs(row, nowMs)
