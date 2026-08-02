import { type CSSProperties, useState } from "react"
import {
  type ArchiveLeg,
  archiveLegLaneStyle,
  archiveLegText,
  isArchiveAbandoned,
  isArchiveNoChangeComplete,
  planArchiveLegs,
} from "./archive-legs.js"
import { Copy } from "./copy.js"
import {
  forgeChangeRequestNoun,
  forgeChangeRequestShort,
} from "./forge-change-request.js"
import {
  formatDuration,
  formatTerminalAgo,
  totalElapsedMs,
  useNowMs,
  worktreeLeafName,
} from "./live-duration.js"
import type { Repository, WorkItem } from "./routes/index.js"
import { sessionWorktreeParts } from "./session-worktree-line.js"
import { cx, ui } from "./ui.js"
import { workItemIssueUrl } from "./work-item-issue-url.js"
import { lifecycleStepChipClassNameForStatus } from "./work-item-progress-chrome.js"
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
 * legs (BUILD / REVIEW / PR|MR) that expand to fine-grained lifecycle chips
 * (same pattern as Kanban earlier-lane summaries). The forge change-request
 * badge sits top-right; dashed "No change" stays in the footer. Meta shows
 * the full session id.
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
  const forge = repository?.forge
  const changeShort = forgeChangeRequestShort(forge)
  const changeNoun = forgeChangeRequestNoun(forge)
  const issueIdentity =
    issueTitle === undefined
      ? `#${workItem.issueNumber}`
      : `#${workItem.issueNumber} · ${issueTitle}`
  const { sessionId, worktreePath } = sessionWorktreeParts(
    workItem.sessionId,
    workItem.worktreePath,
  )
  const legs = planArchiveLegs({ ...workItem, forge })
  const [expandedLegIds, setExpandedLegIds] = useState(() => new Set<string>())
  const toggleLeg = (legId: string) => {
    setExpandedLegIds((current) => {
      const next = new Set(current)
      if (next.has(legId)) {
        next.delete(legId)
      } else {
        next.add(legId)
      }
      return next
    })
  }
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
  const expandedLegs = legs.filter(
    (leg) => expandedLegIds.has(leg.id) && leg.chips.length > 0,
  )

  return (
    <li
      className={cx(
        ui.archiveRow,
        abandoned ? ui.archiveRowAbandoned : ui.archiveRowComplete,
      )}
    >
      <div className={ui.archiveRowTop}>
        <p className={ui.archiveRepo} title={repositoryLabel}>
          {repositoryLabel}
        </p>
        <div className={ui.archiveRowTopEnd}>
          {abandoned ? (
            <span className={cx(ui.archiveStamp, ui.archiveStampAbandoned)}>
              Abandoned
            </span>
          ) : null}
          {!noChange && pullRequestUrl !== null && prNumber !== null ? (
            <a
              className={cx(ui.prbadge, ui.archiveLeg, ui.prbadgeTop)}
              href={pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${changeNoun} #${prNumber}`}
            >
              {changeShort} #{prNumber} ↗
            </a>
          ) : null}
        </div>
      </div>
      {issueUrl !== null && issueUrl !== "" ? (
        <a
          className={cx(
            ui.archiveTitle,
            ui.archiveTitleLink,
            abandoned && ui.archiveTitleAbandoned,
          )}
          href={issueUrl}
          title={issueIdentity}
        >
          <span className={ui.archiveTitleNum}>#{workItem.issueNumber}</span>
          {issueTitle !== undefined ? issueTitle : null}
        </a>
      ) : (
        <p
          className={cx(ui.archiveTitle, abandoned && ui.archiveTitleAbandoned)}
          title={issueIdentity}
        >
          <span className={ui.archiveTitleNum}>#{workItem.issueNumber}</span>
          {issueTitle !== undefined ? issueTitle : null}
        </p>
      )}

      <p className={ui.archiveMeta}>
        {workItem.agentBackend.label}
        {sessionId !== null ? (
          <>
            {" — "}
            <button
              type="button"
              className={ui.archiveMetaSess}
              title={sessionId}
              onClick={() => {
                onOpenSession(workItem.id, sessionId)
              }}
            >
              {sessionId}
            </button>{" "}
            <Copy value={sessionId} showValue={false} className="shrink-0" />
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
        <p className={ui.archiveSummary}>“{summary}”</p>
      ) : null}

      <div className={ui.archiveJourney}>
        <div className={ui.archiveFoot}>
          {legs.map((leg) => (
            <ArchiveLegControl
              key={leg.id}
              leg={leg}
              workItemId={workItem.id}
              expanded={expandedLegIds.has(leg.id)}
              onToggle={() => {
                toggleLeg(leg.id)
              }}
            />
          ))}
          {noChange ? <span className={ui.nochange}>No change</span> : null}
        </div>
        {expandedLegs.map((leg) => {
          const chipsId = `archive-leg-chips-${workItem.id}-${leg.id}`
          return (
            <ol
              key={leg.id}
              id={chipsId}
              className={ui.archiveLegChips}
              aria-label={`${leg.label} lifecycle steps`}
            >
              {leg.chips.map((chip) => {
                const duration =
                  chip.durationMs === null
                    ? null
                    : formatDuration(chip.durationMs)
                return (
                  <li key={chip.phase}>
                    <span
                      className={cx(
                        lifecycleStepChipClassNameForStatus(chip.status),
                        ui.archiveLeg,
                      )}
                    >
                      {chip.label}
                      {duration !== null ? (
                        <span className={ui.archiveLegChipDuration}>
                          {" "}
                          · {duration}
                        </span>
                      ) : null}
                    </span>
                  </li>
                )
              })}
            </ol>
          )
        })}
      </div>
    </li>
  )
}

function ArchiveLegControl({
  leg,
  workItemId,
  expanded,
  onToggle,
}: {
  readonly leg: ArchiveLeg
  readonly workItemId: string
  readonly expanded: boolean
  readonly onToggle: () => void
}) {
  const text = archiveLegText(leg)
  const expandable = leg.chips.length > 0
  const chipsId = `archive-leg-chips-${workItemId}-${leg.id}`
  const title = expandable
    ? expanded
      ? `Collapse ${leg.label} steps`
      : `Expand ${leg.label} steps`
    : (leg.title ?? undefined)

  if (leg.kind === "done" && leg.lane !== null) {
    const style = archiveLegLaneStyle(leg.lane) as CSSProperties
    if (!expandable) {
      return (
        <span
          className={cx(ui.leg, ui.archiveLeg, ui.legLane)}
          style={style}
          title={title}
        >
          {text}
        </span>
      )
    }
    return (
      <button
        type="button"
        className={cx(ui.leg, ui.archiveLeg, ui.legLane, ui.legExpandable)}
        style={style}
        title={title}
        aria-expanded={expanded}
        aria-controls={expanded ? chipsId : undefined}
        onClick={onToggle}
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        {text}
      </button>
    )
  }

  if (leg.kind === "fail") {
    if (!expandable) {
      return (
        <span className={cx(ui.leg, ui.archiveLeg, ui.legFail)} title={title}>
          {text}
        </span>
      )
    }
    return (
      <button
        type="button"
        className={cx(ui.leg, ui.archiveLeg, ui.legFail, ui.legExpandable)}
        title={title}
        aria-expanded={expanded}
        aria-controls={expanded ? chipsId : undefined}
        onClick={onToggle}
      >
        <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        {text}
      </button>
    )
  }

  return (
    <span
      className={cx(ui.leg, ui.archiveLeg, ui.legSkip)}
      title={leg.title ?? undefined}
    >
      {text}
    </span>
  )
}
