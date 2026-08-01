import { useQueries, useSuspenseQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type CSSProperties, Suspense, useState } from "react"
import { Banner } from "./banner.js"
import { Copy } from "./copy.js"
import { useJobsRepositoryFilter } from "./jobs-repository-filter.js"
import { KanbanLiveUpdates } from "./kanban-live.js"
import {
  formatDuration,
  formatStartedAgo,
  totalElapsedMs,
  useNowMs,
} from "./live-duration.js"
import {
  PIPELINE_LANES,
  type PipelineLaneId,
  pipelineLaneFor,
} from "./pipeline-lanes.js"
import {
  JOBS_FAILED_LIMIT,
  JobsCardSkeleton,
  type Repository,
  SessionUsageDialog,
  type WorkItem,
  WorkItemLifecycleStatus,
  WorkItemPauseButton,
  issuesQuery,
  jobsCompletedWorkItemsQuery,
  jobsFailedWorkItemsQuery,
  jobsWorkingWorkItemsQuery,
  repositoriesQuery,
} from "./routes/index.js"
import { sessionWorktreeParts } from "./session-worktree-line.js"
import { cx, ui } from "./ui.js"
import { workItemIssueUrl } from "./work-item-issue-url.js"
import {
  prBadgeClassName,
  statusBadgeClassNameForStatus,
} from "./work-item-progress-chrome.js"
import { workItemPullRequestUrl } from "./work-item-pull-request-url.js"

const sortNewestFirst = (items: readonly WorkItem[]): readonly WorkItem[] =>
  items
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))

const sortCompletedNewestFirst = (
  items: readonly WorkItem[],
): readonly WorkItem[] =>
  items
    .slice()
    .sort((left, right) => right.stateReadyAt.localeCompare(left.stateReadyAt))

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
  onOpenSession,
}: {
  readonly workItem: WorkItem
  readonly repository: Repository | undefined
  readonly issue: { readonly title: string; readonly url: string } | undefined
  readonly laneId: PipelineLaneId
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
  const { sessionId, worktreePath } = sessionWorktreeParts(
    workItem.sessionId,
    workItem.worktreePath,
  )
  const lane = PIPELINE_LANES.find((candidate) => candidate.id === laneId)
  const isCompleteLane = laneId === "complete"

  return (
    <li
      className={ui.jobTicket}
      data-lane={laneId}
      style={{ "--ticket-color": lane?.color ?? "#151515" } as CSSProperties}
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
          <span
            className={cx(
              ui.jobTicketState,
              statusBadgeClassNameForStatus(workItem.status),
            )}
          >
            {workItem.stateLabel}
          </span>
          <WorkItemPauseButton workItem={workItem} />
        </div>
      )}
      <div className={ui.jobTicketRuntime}>
        <p className={ui.jobTicketRuntimeLine}>{workItem.agentBackend.label}</p>
        {sessionId !== null ? (
          <div
            className={cx(
              ui.jobTicketRuntimeLine,
              "flex min-w-0 items-center gap-1",
            )}
          >
            <button
              type="button"
              className={cx(ui.jobTicketSession, "min-w-0 truncate")}
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
        />
      )}
    </li>
  )
}

function KanbanJobsBoard() {
  const { selectedRepositoryId } = useJobsRepositoryFilter()
  const [mobileLane, setMobileLane] = useState<PipelineLaneId>("queue")
  const [sessionDialog, setSessionDialog] = useState<{
    readonly workItemId: string
    readonly sessionId: string
  } | null>(null)
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)
  const workingQueries = useQueries({
    queries: repositories.map((repository) =>
      jobsWorkingWorkItemsQuery(repository.id),
    ),
  })
  const failedQueries = useQueries({
    queries: repositories.map((repository) =>
      jobsFailedWorkItemsQuery(repository.id),
    ),
  })
  const completedQueries = useQueries({
    queries: repositories.map((repository) =>
      jobsCompletedWorkItemsQuery(repository.id),
    ),
  })
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

  const workingItems = sortNewestFirst(
    workingQueries.flatMap((query) => query.data ?? []),
  )
  const failedItems = sortNewestFirst(
    failedQueries.flatMap((query) => query.data ?? []),
  ).slice(0, JOBS_FAILED_LIMIT)
  const completedItems = sortCompletedNewestFirst(
    completedQueries.flatMap((query) => query.data ?? []),
  )
  // Preserve per-list recency: Working/Failed by createdAt, Completed by
  // stateReadyAt. Do not re-sort the merge by createdAt or Merged-lane order
  // drifts from completed history.
  const pipelineItems = Array.from(
    new Map(
      [...workingItems, ...failedItems, ...completedItems].map((item) => [
        item.id,
        item,
      ]),
    ).values(),
  )
  const activeQueries = [
    ...workingQueries,
    ...failedQueries,
    ...completedQueries,
  ]
  const loading = activeQueries.some((query) => query.isLoading)
  const failed = activeQueries.some((query) => query.isError)
  const visiblePipelineItems =
    selectedRepositoryId === null
      ? pipelineItems
      : pipelineItems.filter(
          (item) => item.repositoryId === selectedRepositoryId,
        )
  const laneItems = new Map(
    PIPELINE_LANES.map((lane) => [
      lane.id,
      visiblePipelineItems.filter(
        (workItem) => pipelineLaneFor(workItem) === lane.id,
      ),
    ]),
  )

  if (loading && pipelineItems.length === 0) {
    return <JobsCardSkeleton />
  }

  if (failed) {
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
              {lane.label} {laneItems.get(lane.id)?.length ?? 0}
            </button>
          ))}
        </fieldset>
        <section className={ui.pipelineBoard} aria-label="Lifecycle pipeline">
          <div className={ui.pipelineRoute}>
            {PIPELINE_LANES.map((lane) => {
              const count = laneItems.get(lane.id)?.length ?? 0
              return (
                <span
                  className={ui.laneRoundel}
                  data-lane={lane.id}
                  key={lane.id}
                  role="img"
                  aria-label={`${count} jobs in ${lane.label}`}
                  style={
                    {
                      "--lane-color": lane.color,
                      "--lane-text": lane.text,
                    } as CSSProperties
                  }
                >
                  {count}
                </span>
              )
            })}
          </div>
          <div className={ui.pipelineLanes}>
            {PIPELINE_LANES.map((lane) => {
              const items = laneItems.get(lane.id) ?? []
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
                  <header
                    className={cx(
                      ui.laneHeader,
                      lane.id === "complete" && ui.laneHeaderComplete,
                    )}
                  >
                    <h3 className={ui.laneTitle} id={`lane-${lane.id}`}>
                      {lane.label}
                    </h3>
                  </header>
                  {items.length === 0 ? (
                    <p className={ui.laneEmpty}>Lane clear</p>
                  ) : (
                    <ul className={ui.laneStack}>
                      {items.map((workItem) => (
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
                          onOpenSession={(workItemId, sessionId) =>
                            setSessionDialog({ workItemId, sessionId })
                          }
                        />
                      ))}
                    </ul>
                  )}
                  {lane.id === "queue" && (
                    <aside className={ui.queueHint}>
                      <span className={ui.queueHintTag}>Queue</span>
                      <p className={ui.queueHintText}>
                        Feed the queue — work starts at your repos.
                      </p>
                      <Link to="/repos" className={ui.queueHintLink}>
                        Manage repos →
                      </Link>
                    </aside>
                  )}
                </section>
              )
            })}
          </div>
        </section>
      </div>
      <SessionUsageDialog
        workItemId={sessionDialog?.workItemId ?? null}
        sessionId={sessionDialog?.sessionId ?? null}
        open={sessionDialog !== null}
        onClose={() => setSessionDialog(null)}
      />
    </article>
  )
}
