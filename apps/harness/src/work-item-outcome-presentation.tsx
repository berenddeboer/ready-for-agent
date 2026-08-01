import { ui } from "./ui.js"
import { prBadgeClassName } from "./work-item-progress-chrome.js"

/**
 * Presentational outcome chrome for a Work Item: PR links for changed work, or
 * the distinct No-Change Outcome message, Issue link, and completion summary.
 */
export function WorkItemOutcomePresentation({
  state,
  statusLabel,
  statusBadgeClassName,
  pullRequestNumber,
  pullRequestUrl,
  completionSummary,
  issueUrl,
}: {
  state: string
  statusLabel: string
  statusBadgeClassName: string
  pullRequestNumber: number | null
  pullRequestUrl: string | null
  completionSummary: string | null
  issueUrl: string | null
}) {
  const isNoChangeComplete =
    state === "COMPLETE" &&
    pullRequestNumber === null &&
    completionSummary !== null &&
    completionSummary.trim() !== ""
  const prNumber = pullRequestNumber
  const openPullRequestLabel =
    prNumber === null ? null : `Open pull request #${prNumber}`
  const summary = completionSummary?.trim() ?? ""

  return (
    <>
      <span className="flex flex-wrap items-center justify-end gap-1">
        {!isNoChangeComplete &&
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
