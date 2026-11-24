import { ui } from "./ui.js"
import { prBadgeClassName } from "./work-item-progress-chrome.js"

function summarizeSpecValidation(summary: string): {
  readonly reportUrl: string | null
  readonly trackerLabel: string
  readonly counts: readonly string[]
} | null {
  const reportUrl =
    summary.match(/^Report:\s*(https:\/\/\S+)/m)?.[1] ??
    summary.match(/^Spec:\s*(https:\/\/\S+)/m)?.[1] ??
    null
  const met = (summary.match(/^### MET\b/gm) ?? []).length
  const unmet = (summary.match(/^### UNMET\b/gm) ?? []).length
  const unverified = (summary.match(/^### UNVERIFIED\b/gm) ?? []).length
  const waived = (summary.match(/^### WAIVED\b/gm) ?? []).length
  const followUps = (
    summary.match(/^- \[.+\]\(<?https?:\/\/[^)\s>]+>?\)$/gm) ?? []
  ).length
  const total = met + unmet + unverified + waived
  if (total === 0 && reportUrl === null) return null

  const counts = [
    met > 0 ? `${met} met` : null,
    unmet > 0 ? `${unmet} unmet` : null,
    unverified > 0 ? `${unverified} unverified` : null,
    waived > 0 ? `${waived} waived` : null,
    followUps > 0
      ? `${followUps} follow-up${followUps === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => part !== null)

  let trackerLabel = "tracker"
  if (reportUrl !== null) {
    try {
      const host = new URL(reportUrl).hostname.toLowerCase()
      if (host === "linear.app" || host.endsWith(".linear.app")) {
        trackerLabel = "Linear"
      } else if (host === "github.com" || host.endsWith(".github.com")) {
        trackerLabel = "GitHub"
      }
    } catch {
      // Keep default label.
    }
  }

  return { reportUrl, trackerLabel, counts }
}

/**
 * Presentational outcome chrome for a Work Item: PR links for changed work, or
 * the distinct No-Change Outcome message, Issue link, and completion summary.
 *
 * `showPullRequestBadge` defaults true. Kanban tickets that promote the PR
 * control into the top status row pass false so the outcome row keeps only the
 * status badge (still linked to the PR when a URL exists).
 */
export function WorkItemOutcomePresentation({
  state,
  statusLabel,
  statusBadgeClassName,
  pullRequestNumber,
  pullRequestUrl,
  completionSummary,
  isSpecValidation = false,
  issueUrl,
  showPullRequestBadge = true,
}: {
  state: string
  statusLabel: string
  statusBadgeClassName: string
  pullRequestNumber: number | null
  pullRequestUrl: string | null
  completionSummary: string | null
  isSpecValidation?: boolean
  issueUrl: string | null
  showPullRequestBadge?: boolean
}) {
  const isNoChangeComplete =
    !isSpecValidation &&
    state === "COMPLETE" &&
    pullRequestNumber === null &&
    completionSummary !== null &&
    completionSummary.trim() !== ""
  const prNumber = pullRequestNumber
  const openPullRequestLabel =
    prNumber === null ? null : `Open pull request #${prNumber}`
  const summary = completionSummary?.trim() ?? ""
  const specRollup =
    isSpecValidation && summary !== "" ? summarizeSpecValidation(summary) : null

  return (
    <>
      <span className="flex flex-wrap items-center justify-end gap-1">
        {showPullRequestBadge &&
          !isNoChangeComplete &&
          pullRequestUrl !== null &&
          prNumber !== null && (
            <a
              className={prBadgeClassName}
              href={pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={openPullRequestLabel ?? undefined}
            >
              PR #{prNumber} ↗
            </a>
          )}
        {!isNoChangeComplete &&
        pullRequestUrl !== null &&
        openPullRequestLabel !== null ? (
          <a
            className={`${statusBadgeClassName} no-underline hover:underline`}
            href={pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${openPullRequestLabel}: ${statusLabel}`}
          >
            {statusLabel}
          </a>
        ) : (
          <span className={statusBadgeClassName}>{statusLabel}</span>
        )}
      </span>
      {isSpecValidation && summary !== "" && (
        <section
          className={`w-full min-w-0 ${ui.completionSummary}`}
          aria-label="Spec validation findings"
        >
          {specRollup !== null ? (
            <div className="grid gap-1">
              {specRollup.counts.length > 0 && (
                <p className="m-0 font-mono text-xs text-ink">
                  {specRollup.counts.join(" · ")}
                </p>
              )}
              {specRollup.reportUrl !== null && (
                <a
                  className="font-mono text-xs font-semibold text-ink-2 underline decoration-signal underline-offset-4 hover:text-ink"
                  href={specRollup.reportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View full report on {specRollup.trackerLabel} ↗
                </a>
              )}
            </div>
          ) : (
            <p className={`${ui.completionSummaryP} line-clamp-3 break-words`}>
              {summary}
            </p>
          )}
        </section>
      )}
      {isNoChangeComplete && (
        <div className="mt-1.5 w-full basis-full">
          {issueUrl !== null && issueUrl !== "" ? (
            <a
              className="m-0 font-mono text-xs font-semibold tracking-wide text-ink-2 uppercase underline decoration-signal underline-offset-4 hover:text-ink"
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Issue closed without repository changes
            </a>
          ) : (
            <p className="m-0 font-mono text-xs font-semibold tracking-wide text-ink-2 uppercase">
              Issue closed without repository changes
            </p>
          )}
          {summary !== "" && (
            <section
              className={ui.completionSummary}
              aria-label="Completion summary"
            >
              <p>{summary}</p>
            </section>
          )}
        </div>
      )}
    </>
  )
}
