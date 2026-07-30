import { useQueries, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type CSSProperties, Suspense, useState } from "react"
import { Copy } from "../copy.js"
import { KanbanLiveUpdates } from "../kanban-live.js"
import {
  formatDuration,
  formatStartedAgo,
  totalElapsedMs,
  useNowMs,
} from "../live-duration.js"
import {
  PIPELINE_LANES,
  type PipelineLaneId,
  pipelineLaneFor,
} from "../pipeline-lanes.js"
import { sessionWorktreeParts } from "../session-worktree-line.js"
import { workItemIssueUrl } from "../work-item-issue-url.js"
import { prBadgeClassName } from "../work-item-progress-chrome.js"
import { workItemPullRequestUrl } from "../work-item-pull-request-url.js"
import {
  CommittedPullRequestsDashboard,
  JOBS_COMPLETED_WINDOW_HOURS,
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
} from "./index.js"

type JobsTab = "pipeline" | "completed"

const JOBS_COMPLETED_TAB_LABEL = `Completed last ${JOBS_COMPLETED_WINDOW_HOURS} h`

const JOBS_TABS = [
  { id: "pipeline", label: "Pipeline" },
  { id: "completed", label: JOBS_COMPLETED_TAB_LABEL },
] as const satisfies readonly { id: JobsTab; label: string }[]

const JOBS_COMPLETED_EMPTY_MESSAGE = `No jobs completed in the last ${JOBS_COMPLETED_WINDOW_HOURS} h.`

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

export const Route = createFileRoute("/kanban")({
  component: KanbanPage,
})

function KanbanPage() {
  return (
    <main className="industrial-shell pt-6 sm:pt-8">
      <section aria-label="Committed pull requests" className="mb-5">
        <CommittedPullRequestsDashboard />
      </section>
      <section aria-label="Jobs" className="pipeline-section">
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
 * Gated by assigned lane (`laneId === "complete"`), not by which Jobs tab
 * hosts the ticket — so Pipeline Merged-lane cards and Kanban Completed-tab
 * rows that classify as complete share this compact view. Homepage Jobs
 * Completed is unaffected (it never uses PipelineTicket).
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
    <div className="mt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs tracking-[0.1em] text-ink-faint uppercase">
          {formatStartedAgo(workItem.createdAt, nowMs)}
        </span>
        <span className="font-mono text-xs text-ink-faint">{elapsedLabel}</span>
      </div>
      {pullRequestUrl !== null &&
        prNumber !== null &&
        openPullRequestLabel !== null && (
          <div className="mt-1.5">
            <a
              className={prBadgeClassName}
              href={pullRequestUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={openPullRequestLabel}
            >
              PR #{prNumber}
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
      className="job-ticket"
      style={{ "--ticket-color": lane?.color ?? "#151515" } as CSSProperties}
    >
      <p className="job-ticket-repo" title={repositoryLabel}>
        {repositoryLabel}
      </p>
      {issueUrl !== null && issueUrl !== "" ? (
        <a className="job-ticket-title" href={issueUrl}>
          <span className="font-mono">#{workItem.issueNumber}</span>
          {issueTitle === undefined ? null : ` ${issueTitle}`}
        </a>
      ) : (
        <span className="job-ticket-title">
          <span className="font-mono">#{workItem.issueNumber}</span>
          {issueTitle === undefined ? null : ` ${issueTitle}`}
        </span>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="job-ticket-state">{workItem.stateLabel}</span>
        <WorkItemPauseButton workItem={workItem} />
      </div>
      <div className="job-ticket-runtime">
        <div className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 font-mono text-xs text-ink-faint">
            {workItem.agentBackend.label}
          </span>
          {sessionId !== null && (
            <>
              <span className="shrink-0 font-mono text-xs text-ink-faint">
                -
              </span>
              <button
                type="button"
                className="min-w-0 truncate font-mono text-xs text-ink-faint underline-offset-2 hover:text-oxblood hover:underline"
                title={sessionId}
                onClick={() => onOpenSession(workItem.id, sessionId)}
              >
                {sessionId}
              </button>
              <Copy value={sessionId} showValue={false} className="shrink-0" />
            </>
          )}
        </div>
        {worktreePath !== null && (
          <Copy
            value={worktreePath}
            className="min-w-0 max-w-full"
            textClassName="font-mono text-xs text-ink-faint"
          />
        )}
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
          issueUrl={issueUrl}
          pullRequestUrl={pullRequestUrl}
        />
      )}
    </li>
  )
}

function KanbanJobsBoard() {
  const [selectedTab, setSelectedTab] = useState<JobsTab>("pipeline")
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<
    string | null
  >(null)
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
  // drifts from the Completed tab.
  const pipelineItems = Array.from(
    new Map(
      [...workingItems, ...failedItems, ...completedItems].map((item) => [
        item.id,
        item,
      ]),
    ).values(),
  )
  const repositoryFilteredItems = (items: readonly WorkItem[]) =>
    selectedRepositoryId === null
      ? items
      : items.filter((item) => item.repositoryId === selectedRepositoryId)
  const activeItems =
    selectedTab === "pipeline" ? pipelineItems : completedItems
  // Working/Failed list queries still feed the Pipeline board merge; Completed
  // tab uses completed queries only. There are no Working/Failed tabs on Kanban.
  const activeQueries =
    selectedTab === "pipeline"
      ? [...workingQueries, ...failedQueries, ...completedQueries]
      : completedQueries
  const loading = activeQueries.some((query) => query.isLoading)
  const failed = activeQueries.some((query) => query.isError)
  const visibleItems = repositoryFilteredItems(activeItems)
  const visiblePipelineItems = repositoryFilteredItems(pipelineItems)
  const laneItems = new Map(
    PIPELINE_LANES.map((lane) => [
      lane.id,
      visiblePipelineItems.filter(
        (workItem) => pipelineLaneFor(workItem) === lane.id,
      ),
    ]),
  )

  if (loading && activeItems.length === 0) {
    return <JobsCardSkeleton />
  }

  if (failed) {
    return (
      <>
        <KanbanLiveUpdates repositoryIds={repositoryIds} />
        <article className="border-2 border-oxblood bg-oxblood-wash px-4 py-3">
          <p className="m-0 text-sm text-oxblood-deep" role="alert">
            Could not load jobs. Please try again.
          </p>
        </article>
      </>
    )
  }

  return (
    <article>
      <KanbanLiveUpdates repositoryIds={repositoryIds} />
      <div className="pipeline-controls">
        <div className="pipeline-tabs" role="tablist" aria-label="Jobs">
          {JOBS_TABS.map((tab, tabIndex) => {
            const selected = selectedTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`jobs-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`jobs-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                className="pipeline-tab"
                onClick={() => setSelectedTab(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    event.preventDefault()
                    const delta = event.key === "ArrowRight" ? 1 : -1
                    const nextIndex =
                      (tabIndex + delta + JOBS_TABS.length) % JOBS_TABS.length
                    const nextTab = JOBS_TABS[nextIndex]
                    if (nextTab === undefined) return
                    setSelectedTab(nextTab.id)
                    document.getElementById(`jobs-tab-${nextTab.id}`)?.focus()
                  }
                }}
              >
                {tab.label}
                {tab.id === "completed" && ` (${completedItems.length})`}
              </button>
            )
          })}
        </div>
        <fieldset className="repository-filters">
          <legend className="sr-only">Filter jobs by repository</legend>
          <button
            type="button"
            className="repository-filter"
            aria-pressed={selectedRepositoryId === null}
            onClick={() => setSelectedRepositoryId(null)}
          >
            All sources
          </button>
          {repositories.map((repository) => (
            <button
              type="button"
              className="repository-filter"
              aria-pressed={selectedRepositoryId === repository.id}
              key={repository.id}
              onClick={() => setSelectedRepositoryId(repository.id)}
            >
              {repository.projectPath}
            </button>
          ))}
        </fieldset>
      </div>
      <div
        role="tabpanel"
        id={`jobs-panel-${selectedTab}`}
        aria-labelledby={`jobs-tab-${selectedTab}`}
      >
        {selectedTab === "pipeline" ? (
          <>
            <fieldset className="lane-switcher">
              <legend className="sr-only">Pipeline lane</legend>
              {PIPELINE_LANES.map((lane) => (
                <button
                  type="button"
                  className="lane-switch"
                  aria-pressed={mobileLane === lane.id}
                  aria-controls={`lane-panel-${lane.id}`}
                  key={lane.id}
                  onClick={() => setMobileLane(lane.id)}
                >
                  {lane.label} {laneItems.get(lane.id)?.length ?? 0}
                </button>
              ))}
            </fieldset>
            <section className="pipeline-board" aria-label="Lifecycle pipeline">
              {PIPELINE_LANES.map((lane, laneIndex) => {
                const items = laneItems.get(lane.id) ?? []
                return (
                  <section
                    className="pipeline-lane"
                    data-mobile-active={mobileLane === lane.id}
                    id={`lane-panel-${lane.id}`}
                    key={lane.id}
                    aria-labelledby={`lane-${lane.id}`}
                  >
                    <header
                      className="lane-header"
                      style={
                        {
                          "--lane-color": lane.color,
                          "--lane-text": lane.text,
                        } as CSSProperties
                      }
                    >
                      <div>
                        <span className="lane-number">
                          0{laneIndex + 1} / 06
                        </span>
                        <h3 className="lane-title" id={`lane-${lane.id}`}>
                          {lane.label}
                        </h3>
                      </div>
                      <span className="lane-count">
                        {items.length}
                        <span className="sr-only"> jobs</span>
                      </span>
                    </header>
                    {items.length === 0 ? (
                      <p className="lane-empty">Lane clear</p>
                    ) : (
                      <ul className="lane-stack m-0 list-none">
                        {items.map((workItem) => (
                          <PipelineTicket
                            key={workItem.id}
                            workItem={workItem}
                            repository={repositoryById.get(
                              workItem.repositoryId,
                            )}
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
                  </section>
                )
              })}
            </section>
          </>
        ) : visibleItems.length === 0 ? (
          <p className="pipeline-list-empty">{JOBS_COMPLETED_EMPTY_MESSAGE}</p>
        ) : (
          <ul
            className="pipeline-list m-0 grid list-none gap-2"
            aria-label={JOBS_COMPLETED_TAB_LABEL}
          >
            {visibleItems.map((workItem) => {
              const repository = repositoryById.get(workItem.repositoryId)
              const issue = issueByRepoAndNumber.get(
                repositoryIssueKey(workItem.repositoryId, workItem.issueNumber),
              )
              return (
                <PipelineTicket
                  key={workItem.id}
                  workItem={workItem}
                  repository={repository}
                  issue={issue}
                  laneId={pipelineLaneFor(workItem)}
                  onOpenSession={(workItemId, sessionId) =>
                    setSessionDialog({ workItemId, sessionId })
                  }
                />
              )
            })}
          </ul>
        )}
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
