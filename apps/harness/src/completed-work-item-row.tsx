import type { CSSProperties } from "react"
import {
  archiveLegLaneStyle,
  archiveLegText,
  isArchiveAbandoned,
  isArchiveNoChangeComplete,
  planArchiveLegs,
} from "./archive-legs.js"
import { Copy } from "./copy.js"
import {
  formatDuration,
  formatSessionShort,
  formatTerminalAgo,
  totalElapsedMs,
  useNowMs,
  worktreeLeafName,
} from "./live-duration.js"
import type { Repository, WorkItem } from "./routes/index.js"
import { sessionWorktreeParts } from "./session-worktree-line.js"
import { workItemIssueUrl } from "./work-item-issue-url.js"
import { workItemPullRequestUrl } from "./work-item-pull-request-url.js"

export type CompletedWorkItemIssueLookup = {
  readonly title: string
  readonly url: string
}

/**
 * Completed Work Item archive row for the historical Completed page
 * (`docs/harness-design-system.md` §4.5, wayfinder #698 prototype).
 *
 * Complete rows: 6px Merged line bar, no stamp. Abandoned rows: dashed border,
 * ghosted title, dashed ABANDONED stamp. Footer carries lane-coloured archive
 * legs plus a PR badge or dashed "No change" tag.
 */
export function CompletedWorkItemRow({
  workItem,
  repository,
  issue,
  onOpenSession,
}: {
  readonly workItem: WorkItem
  readonly repository: Repository | undefined
  readonly issue: CompletedWorkItemIssueLookup | undefined
  readonly onOpenSession: (workItemId: string, sessionId: string) => void
}) {
  const nowMs = useNowMs(true)
  const abandoned = isArchiveAbandoned(workItem)
  const noChange = isArchiveNoChangeComplete(workItem)
  const repositoryLabel =
    repository === undefined ? workItem.repositoryId : repository.projectPath
  const issueTitle = issue?.title ?? workItem.issueTitle ?? undefined
  const issueUrl =
    issue?.url !== undefined && issue.url !== ""
      ? issue.url
      : repository === undefined
        ? null
        : workItemIssueUrl(
            repository.forge,
            repository.forgeHost,
            repository.projectPath,
            workItem.issueNumber,
          )
  const pullRequestUrl =
    repository === undefined
      ? null
      : workItemPullRequestUrl(
          repository.forge,
          repository.forgeHost,
          repository.projectPath,
          workItem.pullRequestNumber,
        )
  const prNumber = workItem.pullRequestNumber
  const issueIdentity =
    issueTitle === undefined
      ? `#${workItem.issueNumber}`
      : `#${workItem.issueNumber} · ${issueTitle}`
  const { sessionId, worktreePath } = sessionWorktreeParts(
    workItem.sessionId,
    workItem.worktreePath,
  )
  const legs = planArchiveLegs(workItem)
  const elapsedMs = totalElapsedMs(workItem.createdAt, workItem.stateReadyAt)
  const terminalVerb = abandoned
    ? "Withdrawn"
    : prNumber !== null
      ? "Merged"
      : "Finished"
  const terminalAgo = formatTerminalAgo(
    workItem.stateReadyAt,
    terminalVerb,
    nowMs,
  )
  const elapsedLabel = `Elapsed ${formatDuration(elapsedMs)}`
  const summary = workItem.completionSummary?.trim() ?? ""

  return (
    <li
      className={
        abandoned
          ? "archive-row archive-row--abandoned"
          : "archive-row archive-row--complete"
      }
    >
      <div className="archive-row-top">
        <div style={{ minWidth: 0 }}>
          <p className="archive-repo" title={repositoryLabel}>
            {repositoryLabel}
          </p>
          {issueUrl !== null && issueUrl !== "" ? (
            <a className="archive-title" href={issueUrl} title={issueIdentity}>
              <span className="num">#{workItem.issueNumber}</span>
              {issueTitle !== undefined ? ` · ${issueTitle}` : null}
            </a>
          ) : (
            <p className="archive-title" title={issueIdentity}>
              <span className="num">#{workItem.issueNumber}</span>
              {issueTitle !== undefined ? ` · ${issueTitle}` : null}
            </p>
          )}
        </div>
        {abandoned ? (
          <span className="archive-stamp archive-stamp--abandoned">
            Abandoned
          </span>
        ) : null}
      </div>

      <p className="archive-meta">
        {workItem.agentBackend.label}
        {sessionId !== null ? (
          <>
            {" — "}
            <button
              type="button"
              className="sess"
              title={sessionId}
              onClick={() => {
                onOpenSession(workItem.id, sessionId)
              }}
            >
              {formatSessionShort(sessionId)}
            </button>{" "}
            <Copy
              value={sessionId}
              className="inline-flex shrink-0"
              showValue={false}
            />
          </>
        ) : (
          " — No session"
        )}
        {worktreePath !== null ? (
          <>
            {" — WT "}
            <span title={worktreePath}>{worktreeLeafName(worktreePath)}</span>
          </>
        ) : null}
        {` · ${terminalAgo} · ${elapsedLabel}`}
      </p>

      {noChange && summary !== "" ? (
        <p className="archive-summary">“{summary}”</p>
      ) : null}

      <div className="archive-foot">
        {legs.map((leg) => {
          const text = archiveLegText(leg)
          if (leg.kind === "done" && leg.lane !== null) {
            return (
              <span
                key={leg.id}
                className="leg leg--lane"
                style={archiveLegLaneStyle(leg.lane) as CSSProperties}
              >
                {text}
              </span>
            )
          }
          if (leg.kind === "fail") {
            return (
              <span key={leg.id} className="leg leg--fail">
                {text}
              </span>
            )
          }
          return (
            <span key={leg.id} className="leg leg--skip">
              {text}
            </span>
          )
        })}
        {noChange ? (
          <span className="nochange">No change</span>
        ) : pullRequestUrl !== null && prNumber !== null ? (
          <a
            className="prbadge"
            href={pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open pull request #${prNumber}`}
          >
            PR #{prNumber} ↗
          </a>
        ) : null}
      </div>
    </li>
  )
}
