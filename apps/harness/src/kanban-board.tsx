import { useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type CSSProperties, Suspense, useMemo, useState } from "react"
import { Banner } from "./banner.js"
import { Copy } from "./copy.js"
import { ExecutionProfileSummary } from "./execution-profile-summary.js"
import {
  JobsCardSkeleton,
  type Repository,
  type WorkItem,
  WorkItemLifecycleStatus,
  WorkItemPauseButton,
  issuesQuery,
  kanbanStatusQuery,
  repositoriesQuery,
} from "./home-page-content.js"
import { useJobsRepositoryFilter } from "./jobs-repository-filter.js"
import { KanbanLiveUpdates } from "./kanban-live.js"
import {
  formatDuration,
  formatStartedAgo,
  totalElapsedMs,
  useNowMs,
} from "./live-duration.js"
import { MetalLaneHeader } from "./metal-lane-header.js"
import { PipelineBottomOrnament } from "./pipeline-bottom-ornament.js"
import { PIPELINE_LANES, type PipelineLaneId } from "./pipeline-lanes.js"
import { PipelineRoute, usePipelineRouteFlights } from "./pipeline-route.js"
import {
  ROUTE_TRANSITION_MS,
  presentLaneColumnItems,
} from "./pipeline-route-transition.js"
import { openSessionTelemetry } from "./session-telemetry-nav.js"
import { sessionWorktreeParts } from "./session-worktree-line.js"
import { cx, ui } from "./ui.js"
import { workItemIssueUrl } from "./work-item-issue-url.js"
import {
  kanbanPullRequestBadgePlacement,
  prBadgeClassName,
  statusBadgeClassNameForStatus,
} from "./work-item-progress-chrome.js"
import { workItemPullRequestUrl } from "./work-item-pull-request-url.js"

const repositoryIssueKey = (
  repositoryId: string,
  issueNumber: number,
): string => `${repositoryId}:${issueNumber}`

/**
 * Kanban board content for the home page (`/`) when at least one repository
 * is configured. Zero-repo empty slate is handled by the route.
 */
export function KanbanBoard() {
  // Merged-PR throughput lives in sticky root chrome (every route).
  // data-kanban-surface: board stays light tokens in dark theme (styles.css).
  return (
    <main className={ui.industrialShell} data-kanban-surface="">
      <section aria-label="Jobs" className="mt-0">
        <Suspense fallback={<JobsCardSkeleton />}>
          <KanbanJobsBoard />
        </Suspense>
      </section>
    </main>
  )
}

/**
 * Merged-lane tickets omit per-step lifecycle chrome. Show only start time
 * and total elapsed duration, plus a PR link when one exists.
 *
 * Gated by assigned lane (`laneId === "complete"`). Pipeline Merged-lane cards
 * use this compact view; the Completed surface uses archive cards instead.
 *
 * No-change completion-summary chrome is intentionally omitted: issue #630
 * limits Merged-lane status to start + total duration (and PR identity).
 */
function PipelineCompleteSummary({
  workItem,
  pullRequestUrl,
}: {
  readonly workItem: WorkItem
  readonly pullRequestUrl: string | null
}) {
  const nowMs = useNowMs(true)
  const elapsedMs = totalElapsedMs(workItem.createdAt, workItem.stateReadyAt)
  const elapsedLabel = `Elapsed ${formatDuration(elapsedMs)}`
  const prNumber = workItem.pullRequestNumber
  const openPullRequestLabel =
    prNumber === null ? null : `Open pull request #${prNumber}`

  return (
    <div className="mt-1 grid gap-1">
      <p className={ui.jobTicketRuntimeLine}>
        {formatStartedAgo(workItem.createdAt, nowMs)}
      </p>
      <p className={ui.jobTicketRuntimeLine}>{elapsedLabel}</p>
      {pullRequestUrl !== null &&
        prNumber !== null &&
        openPullRequestLabel !== null && (
          <div className="mt-0.5">
            <a
              className={prBadgeClassName}
              href={pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={openPullRequestLabel}
            >
              PR #{prNumber} ↗
            </a>
          </div>
        )}
    </div>
  )
}

function PipelineTicket({
  workItem,
  repository,
  issue,
  laneId,
  departing = false,
  arriving = false,
  onOpenSession,
}: {
  readonly workItem: WorkItem
  readonly repository: Repository | undefined
  readonly issue: { readonly title: string; readonly url: string } | undefined
  readonly laneId: PipelineLaneId
  /** In-flight on the route line — stay in source lane, greyed out. */
  readonly departing?: boolean
  /**
   * Destination lane during absorb — opacity fades from transparent to full
   * over the absorb phase (no layout/transform motion).
   */
  readonly arriving?: boolean
  readonly onOpenSession: (workItemId: string, sessionId: string) => void
}) {
  const repositoryLabel = repository?.projectPath ?? workItem.repositoryId
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
  const openPullRequestLabel =
    prNumber === null ? null : `Open pull request #${prNumber}`
  // Needs Human + PR: PR control in top status row; outcome keeps one alarm badge.
  const prBadgePlacement = kanbanPullRequestBadgePlacement({
    status: workItem.status,
    pullRequestNumber: prNumber,
    pullRequestUrl,
  })
  const promotePrToHeader = prBadgePlacement === "header"
  const { sessionId, worktreePath } = sessionWorktreeParts(
    workItem.sessionId,
    workItem.worktreePath,
  )
  const lane = PIPELINE_LANES.find((candidate) => candidate.id === laneId)
  const isCompleteLane = laneId === "complete"
  const ticketStyle = {
    "--ticket-color": lane?.color ?? "#151515",
    ...(arriving
      ? {
          // Opacity-only; duration tracks absorb so the card finishes with smoke.
          animation: `ticket-arrive ${ROUTE_TRANSITION_MS.absorb}ms ease-out both`,
        }
      : {}),
  } as CSSProperties

  return (
    <li
      className={cx(
        ui.jobTicket,
        departing && ui.jobTicketDeparting,
        arriving && ui.jobTicketArriving,
      )}
      data-lane={laneId}
      data-departing={departing ? "true" : undefined}
      data-arriving={arriving ? "true" : undefined}
      aria-busy={departing || arriving || undefined}
      // inert blocks mouse and keyboard; pointer-events-none alone is not enough.
      // Arriving cards start fully transparent — keep them inert for the fade.
      {...(departing || arriving ? { inert: true } : {})}
      style={ticketStyle}
    >
      <p className={ui.jobTicketRepo} title={repositoryLabel}>
        {repositoryLabel}
      </p>
      {issueUrl !== null && issueUrl !== "" ? (
        <a
          className={cx(ui.jobTicketTitle, ui.jobTicketTitleLink)}
          href={issueUrl}
        >
          <span className={ui.jobTicketNum}>#{workItem.issueNumber}</span>
          {issueTitle === undefined ? null : ` ${issueTitle}`}
        </a>
      ) : (
        <span className={ui.jobTicketTitle}>
          <span className={ui.jobTicketNum}>#{workItem.issueNumber}</span>
          {issueTitle === undefined ? null : ` ${issueTitle}`}
        </span>
      )}
      {/* Merged-lane: status is the lane itself — no COMPLETE tag or pause. */}
      {isCompleteLane ? null : (
        <div className={ui.jobTicketStatus}>
          {promotePrToHeader &&
          pullRequestUrl !== null &&
          prNumber !== null &&
          openPullRequestLabel !== null ? (
            <a
              className={prBadgeClassName}
              href={pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={openPullRequestLabel}
            >
              PR #{prNumber} ↗
            </a>
          ) : (
            <span
              className={cx(
                ui.jobTicketState,
                statusBadgeClassNameForStatus(workItem.status),
              )}
              title={workItem.stateLabel}
            >
              {workItem.stateLabel}
            </span>
          )}
          <WorkItemPauseButton workItem={workItem} />
        </div>
      )}
      <div className={ui.jobTicketRuntime}>
        <p className={ui.jobTicketRuntimeLine}>{workItem.agentBackend.label}</p>
        <ExecutionProfileSummary profile={workItem.executionProfile} />
        {sessionId !== null ? (
          <div
            className={cx(
              ui.jobTicketRuntimeLine,
              "flex min-w-0 max-w-full items-center gap-1",
            )}
          >
            <button
              type="button"
              className={cx(ui.jobTicketSession, "min-w-0 flex-1 truncate")}
              title={sessionId}
              onClick={() => onOpenSession(workItem.id, sessionId)}
            >
              {sessionId}
            </button>
            <Copy value={sessionId} showValue={false} className="shrink-0" />
          </div>
        ) : null}
        {worktreePath !== null ? (
          <Copy
            value={worktreePath}
            className="min-w-0 max-w-full"
            textClassName={ui.jobTicketRuntimeLine}
          />
        ) : null}
      </div>
      {isCompleteLane ? (
        <PipelineCompleteSummary
          workItem={workItem}
          pullRequestUrl={pullRequestUrl}
        />
      ) : (
        <WorkItemLifecycleStatus
          workItem={workItem}
          compact
          collapseEarlierLanes
          issueUrl={issueUrl}
          pullRequestUrl={pullRequestUrl}
          showPullRequestBadge={!promotePrToHeader}
        />
      )}
    </li>
  )
}

function KanbanJobsBoard() {
  const { selectedRepositoryId } = useJobsRepositoryFilter()
  const [mobileLane, setMobileLane] = useState<PipelineLaneId>("queue")
  const navigate = useNavigate()
  const openSessionFromPipeline = (workItemId: string, sessionId: string) => {
    void openSessionTelemetry({
      navigate,
      workItemId,
      sessionId,
    })
  }
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)
  // Server-owned lane membership, source windows, and ordering. Optional
  // repository filter is applied after the shared global source set.
  const {
    data: kanbanStatus,
    isLoading: kanbanLoading,
    isError: kanbanFailed,
  } = useQuery(kanbanStatusQuery(selectedRepositoryId))
  // Issue titles/URLs enrich tickets; membership never comes from this list.
  const issueQueries = useQueries({
    queries: repositories.map((repository) => issuesQuery(repository.id)),
  })

  const repositoryIds = repositories.map(({ id }) => id)
  const repositoryById = new Map(
    repositories.map((repository) => [repository.id, repository] as const),
  )
  const issueByRepoAndNumber = new Map<
    string,
    { readonly title: string; readonly url: string }
  >()
  for (const query of issueQueries) {
    for (const issue of query.data ?? []) {
      issueByRepoAndNumber.set(
        repositoryIssueKey(issue.repositoryId, issue.issueNumber),
        { title: issue.title, url: issue.url },
      )
    }
  }

  const laneItems = useMemo(() => {
    const map = new Map<PipelineLaneId, readonly WorkItem[]>(
      PIPELINE_LANES.map((lane) => [lane.id, [] as const]),
    )
    if (kanbanStatus === undefined) {
      return map
    }
    for (const lane of kanbanStatus.lanes) {
      map.set(lane.id, lane.workItems)
    }
    return map
  }, [kanbanStatus])

  // Route flights: grey source until absorb, then dest card fades in with smoke.
  const routeFlights = usePipelineRouteFlights(laneItems)

  const workItemById = useMemo(() => {
    const map = new Map<string, WorkItem>()
    for (const items of laneItems.values()) {
      for (const item of items) {
        map.set(item.id, item)
      }
    }
    return map
  }, [laneItems])

  if (kanbanLoading && kanbanStatus === undefined) {
    return <JobsCardSkeleton />
  }

  if (kanbanFailed && kanbanStatus === undefined) {
    return (
      <>
        <KanbanLiveUpdates repositoryIds={repositoryIds} />
        <Banner tone="alarm" tag="Error" role="alert">
          Could not load jobs. Please try again.
        </Banner>
      </>
    )
  }

  return (
    <article>
      <KanbanLiveUpdates repositoryIds={repositoryIds} />
      {/* Switcher + filters live in sticky root chrome (JobsViewSwitcher). */}
      <div id="jobs-panel-pipeline">
        <fieldset className={ui.laneSwitcher}>
          <legend className="sr-only">Pipeline lane</legend>
          {PIPELINE_LANES.map((lane) => (
            <button
              type="button"
              className={ui.laneSwitch}
              aria-pressed={mobileLane === lane.id}
              aria-controls={`lane-panel-${lane.id}`}
              key={lane.id}
              onClick={() => setMobileLane(lane.id)}
              style={
                {
                  "--lane-color": lane.color,
                } as CSSProperties
              }
            >
              <span className={ui.laneSwitchSwatch} aria-hidden="true" />
              {lane.label}{" "}
              {routeFlights.displayCounts.get(lane.id) ??
                laneItems.get(lane.id)?.length ??
                0}
            </button>
          ))}
        </fieldset>
        <section className={ui.pipelineBoard} aria-label="Lifecycle pipeline">
          <PipelineRoute
            flights={routeFlights.flights}
            fedLanes={routeFlights.fedLanes}
            displayCounts={routeFlights.displayCounts}
          />
          <div className={ui.pipelineLanes}>
            {PIPELINE_LANES.map((lane, laneIndex) => {
              // Pre-absorb: grey source placeholder; absorb: dest card arrives.
              const items = presentLaneColumnItems({
                laneId: lane.id,
                laneItems: laneItems.get(lane.id) ?? [],
                flights: routeFlights.flights,
                workItemById,
              })
              return (
                <section
                  className={ui.pipelineLane}
                  data-lane={lane.id}
                  data-mobile-active={mobileLane === lane.id}
                  id={`lane-panel-${lane.id}`}
                  key={lane.id}
                  aria-labelledby={`lane-${lane.id}`}
                  style={
                    {
                      "--lane-color": lane.color,
                      "--lane-text": lane.text,
                    } as CSSProperties
                  }
                >
                  <MetalLaneHeader
                    laneId={lane.id}
                    label={lane.label}
                    titleId={`lane-${lane.id}`}
                    ordinal={laneIndex + 1}
                  />
                  {items.length === 0 ? (
                    <p className={ui.laneEmpty}>Lane clear</p>
                  ) : (
                    <ul className={ui.laneStack}>
                      {items.map(({ workItem, departing, arriving }) => (
                        <PipelineTicket
                          key={workItem.id}
                          workItem={workItem}
                          repository={repositoryById.get(workItem.repositoryId)}
                          issue={issueByRepoAndNumber.get(
                            repositoryIssueKey(
                              workItem.repositoryId,
                              workItem.issueNumber,
                            ),
                          )}
                          laneId={lane.id}
                          departing={departing}
                          arriving={arriving}
                          onOpenSession={openSessionFromPipeline}
                        />
                      ))}
                    </ul>
                  )}
                  {lane.id === "queue" && (
                    <aside className={ui.queueHint}>
                      <p className={ui.queueHintText}>
                        Feed the queue — label issues with{" "}
                        <code className={ui.queueHintCode}>
                          ready-for-agent
                        </code>
                        . When they show up in{" "}
                        <Link to="/repos" className={ui.queueHintLink}>
                          your repos
                        </Link>
                        , click Implement.
                      </p>
                      <div className={ui.queueHintMenuIllus} aria-hidden="true">
                        <span className={ui.queueHintImplementBtn}>
                          <svg
                            aria-hidden="true"
                            className={ui.queueHintImplementIcon}
                            viewBox="0 0 24 24"
                            fill="currentColor"
                          >
                            <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.12-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z" />
                          </svg>
                          Implement
                        </span>
                      </div>
                    </aside>
                  )}
                </section>
              )
            })}
          </div>
          <PipelineBottomOrnament />
        </section>
      </div>
    </article>
  )
}
