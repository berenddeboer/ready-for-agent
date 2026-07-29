/**
 * Rolling window for Jobs Completed (Complete and Abandoned).
 * Membership uses stateReadyAt (entry into the terminal state), not a calendar day.
 * JOBS_COMPLETED_WINDOW_HOURS is derived so UI labels stay aligned with the filter.
 *
 * This module is dependency-free so the harness client may import it without
 * pulling server lifecycle code into the Vite bundle.
 */
export const JOBS_COMPLETED_WINDOW_MS = 24 * 60 * 60 * 1000
export const JOBS_COMPLETED_WINDOW_HOURS =
  JOBS_COMPLETED_WINDOW_MS / (60 * 60 * 1000)
