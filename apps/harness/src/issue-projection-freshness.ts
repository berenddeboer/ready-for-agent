/**
 * Client-side freshness for a Repository's Issue projection.
 *
 * Scheduled Issue polls run about every 60–90s
 * (`ISSUE_POLLING_BASE_SECONDS` + jitter in `@ready-for-agent/graphql-api`).
 * Only successful reconciliation advances `issuesReconciledAt`. A non-null
 * timestamp that is older than a small multiple of that cadence means the
 * Issues on screen must not be trusted as current — whether the Harness is
 * failing polls, paused, or not running.
 *
 * No server schema change: the client already receives `issuesReconciledAt`.
 */

/** Upper bound of one healthy poll quiet period (base 60s + jitter 30s). */
const ISSUE_POLL_CADENCE_UPPER_MS = 90_000

/** How many cadence upper bounds without a successful refresh before stale. */
const ISSUE_PROJECTION_STALE_MULTIPLE = 5

/** Age after which a non-null `issuesReconciledAt` is treated as stale. */
export const ISSUE_PROJECTION_STALE_AFTER_MS =
  ISSUE_POLL_CADENCE_UPPER_MS * ISSUE_PROJECTION_STALE_MULTIPLE

/**
 * True when the projection has a last-success timestamp older than the
 * staleness threshold. `null` is "never refreshed" (different UI), not stale.
 */
export function isIssueProjectionStale(
  issuesReconciledAt: string | null,
  nowMs: number,
  staleAfterMs: number = ISSUE_PROJECTION_STALE_AFTER_MS,
): boolean {
  if (issuesReconciledAt === null) return false
  const reconciledAtMs = Date.parse(issuesReconciledAt)
  if (Number.isNaN(reconciledAtMs)) return false
  return nowMs - reconciledAtMs > staleAfterMs
}

/**
 * Relative age caption for a stale Issue list, e.g.
 * "Last refreshed 13 hours ago".
 */
export function formatLastRefreshedAgo(
  issuesReconciledAt: string,
  nowMs: number = Date.now(),
): string {
  const reconciledAtMs = Date.parse(issuesReconciledAt)
  if (Number.isNaN(reconciledAtMs)) return "Last refreshed at an unknown time"
  const elapsedMs = Math.max(0, nowMs - reconciledAtMs)
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) return "Last refreshed just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return minutes === 1
      ? "Last refreshed 1 min ago"
      : `Last refreshed ${minutes} min ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return hours === 1
      ? "Last refreshed 1 hour ago"
      : `Last refreshed ${hours} hours ago`
  }
  const days = Math.floor(hours / 24)
  return days === 1
    ? "Last refreshed 1 day ago"
    : `Last refreshed ${days} days ago`
}
