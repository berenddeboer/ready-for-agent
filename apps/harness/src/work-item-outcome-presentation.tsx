/**
 * Presentational outcome chrome for a Work Item: PR links for changed work, or
 * the distinct No-Change Outcome message, Issue link, and completion summary.
 */
export function WorkItemOutcomePresentation({
  state,
  statusLabel,
  statusBadgeClassName,
  githubPullRequestNumber,
  pullRequestUrl,
  completionSummary,
  issueUrl,
}: {
  state: string
  statusLabel: string
  statusBadgeClassName: string
  githubPullRequestNumber: number | null
  pullRequestUrl: string | null
  completionSummary: string | null
  issueUrl: string | null
}) {
  const isNoChangeComplete =
    state === "COMPLETE" &&
    githubPullRequestNumber === null &&
    completionSummary !== null &&
    completionSummary.trim() !== ""
  const prNumber = githubPullRequestNumber
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
              className="rounded-full bg-slate-200 px-2 py-0.5 text-[0.6rem] font-bold tracking-wide text-slate-700 uppercase hover:bg-slate-300 hover:underline"
              href={pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={openPullRequestLabel ?? undefined}
            >
              PR #{prNumber}
            </a>
          )}
        {!isNoChangeComplete &&
        pullRequestUrl !== null &&
        openPullRequestLabel !== null ? (
          <a
            className={`${statusBadgeClassName} hover:underline`}
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
              className="m-0 text-xs font-semibold text-slate-700 underline decoration-slate-300 underline-offset-2 hover:text-blue-700"
              href={issueUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Issue closed without repository changes
            </a>
          ) : (
            <p className="m-0 text-xs font-semibold text-slate-700">
              Issue closed without repository changes
            </p>
          )}
          {summary !== "" && (
            <section
              className="mt-1.5 rounded-md border border-slate-200 bg-white px-2 py-1.5"
              aria-label="Completion summary"
            >
              <p className="m-0 whitespace-pre-wrap text-xs text-slate-600">
                {summary}
              </p>
            </section>
          )}
        </div>
      )}
    </>
  )
}
