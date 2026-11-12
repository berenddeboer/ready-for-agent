/**
 * Display window for resolved CI Failure Incident history on the
 * Repositories page. Rolling previous 7 × 24 hours, inclusive of the cutoff.
 * Not a retention limit: older incidents stay stored.
 */
export const CI_GATE_RESOLVED_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export const resolvedCiFailureIncidentHistorySinceMs = (
  nowMs: number,
): number => nowMs - CI_GATE_RESOLVED_HISTORY_WINDOW_MS

/**
 * True when a resolved incident's resolution time is inside the history
 * window. Opening time does not decide eligibility. A missing resolution
 * time is outside the window.
 */
export const isResolvedCiFailureIncidentWithinHistoryWindow = (input: {
  readonly resolvedAtMs: number | null
  readonly nowMs: number
}): boolean =>
  input.resolvedAtMs !== null &&
  Number.isFinite(input.resolvedAtMs) &&
  input.resolvedAtMs >= resolvedCiFailureIncidentHistorySinceMs(input.nowMs)
