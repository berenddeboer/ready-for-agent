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

/**
 * Default page size for the historical Completed Work Items page (no 24 h window).
 * Distinct from Jobs Completed, which uses JOBS_COMPLETED_WINDOW_MS with no page cap.
 */
export const COMPLETED_WORK_ITEMS_DEFAULT_PAGE_SIZE = 20
/** Upper bound for historical Completed page size (GraphQL + lifecycle SQL path). */
export const COMPLETED_WORK_ITEMS_MAX_PAGE_SIZE = 100
