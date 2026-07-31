import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import {
  type CSSProperties,
  type FormEvent,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react"
import { createClient } from "@ready-for-agent/graphql-client"
import {
  COMPLETED_WORK_ITEMS_DEFAULT_PAGE_SIZE as completedWorkItemsDefaultPageSize,
  JOBS_COMPLETED_WINDOW_HOURS as jobsCompletedWindowHours,
} from "@ready-for-agent/work-item-lifecycle/jobs-completed-window"
import { Banner, BannerActionButton } from "../banner.js"
import { repositoryCardCollapseId, useCardCollapsed } from "../card-collapse.js"
import { CardCollapseToggle } from "../card-collapse-toggle.js"
import {
  type GraphqlWorkItemState,
  issueActionEligibility,
} from "../issue-action-eligibility.js"
import { KanbanBoard } from "../kanban-board.js"
import {
  formatDuration,
  formatStartedAgo,
  isLiveDurationStatus,
  liveDurationMs,
  useNowMs,
} from "../live-duration.js"
import {
  localCommittedPullRequestDayBounds,
  msUntilNextLocalMidnight,
} from "../local-day-bounds.js"
import {
  ParentIssueActionsMenu,
  isParentImplementAllWithAutoMergeEligible,
} from "../parent-issue-actions-menu.js"
import {
  type LifecycleLabelChip,
  type LifecyclePipelineLaneId,
  lifecycleFocusLaneFor,
  lifecycleLaneForPhase,
  planLifecycleChipPresentation,
} from "../pipeline-lanes.js"
import { followRepositoryIssuesLive } from "../refresh-issues-live.js"
import {
  followOpenPullRequestCountLive,
  openPullRequestCountPresentation,
  openPullRequestCountsQueryKey,
} from "../refresh-open-pull-request-count-live.js"
import {
  followRepositoryMembershipLive,
  liveUpdatesWarningPresentation,
} from "../refresh-repositories-live.js"
import {
  committedPullRequestsCountQueryKeyPrefix,
  completedWorkItemsHistoryQueryKeyPrefix,
  followRepositoryWorkItemsLive,
} from "../refresh-work-items-live.js"
import { workItemIssueUrl } from "../work-item-issue-url.js"
import { canShowWorkItemResetAction } from "../work-item-job-actions.js"
import { WorkItemOutcomePresentation } from "../work-item-outcome-presentation.js"
import {
  lifecycleLaneCssVars,
  lifecycleStepChipClassNameForStatus,
  statusBadgeClassNameForStatus,
  statusMessageClassNameForStatus,
} from "../work-item-progress-chrome.js"
import { workItemPullRequestUrl } from "../work-item-pull-request-url.js"

const graphql = createClient({ url: "/graphql", batch: true })
// Long-lived host folder dialog must not pin co-batched GraphQL operations.
const graphqlUnbatched = createClient({ url: "/graphql", batch: false })

const configQuery = {
  queryKey: ["config"],
  queryFn: async () => {
    const result = await graphql.query({
      config: {
        selectedAgentBackend: true,
        defaultModel: true,
        defaultThinkingLevel: true,
        reviewModel: true,
        reviewThinkingLevel: true,
        maxConcurrentAgentTurns: true,
        maxConcurrentWorkItems: true,
        // Keep selection aligned with Harness Settings so shared cache never
        // drops unfinished / scoped gate fields.
        unfinishedWorkItemCount: true,
        blockingUnfinishedWorkItemCount: true,
      },
    })
    return result.config
  },
}

type AgentModelOption = {
  id: string
  thinkingLevels: readonly string[]
}

type AgentBackendInfo = {
  id: string
  label: string
}

const modelsQuery = {
  queryKey: ["models"],
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  queryFn: async () => {
    const result = await graphql.query({
      models: { id: true, thinkingLevels: true },
    })
    return result.models
  },
}

const agentBackendsQuery = {
  queryKey: ["agentBackends"],
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  queryFn: async () => {
    const result = await graphql.query({
      agentBackends: { id: true, label: true },
    })
    return result.agentBackends
  },
}

/** Empty select value means inherit the harness default (null override). */
const HARNESS_DEFAULT_BACKEND_VALUE = ""

const sessionQuery = (workItemId: string) => ({
  queryKey: ["session", workItemId] as const,
  queryFn: async () => {
    const result = await graphql.query({
      session: {
        __args: { workItemId },
        id: true,
        availability: true,
        backend: { id: true, label: true },
        model: {
          providerId: true,
          id: true,
          thinkingLevel: true,
        },
        tokens: {
          input: true,
          output: true,
          reasoning: true,
          cacheRead: true,
          cacheWrite: true,
        },
        cost: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    return result.session
  },
})

const formatSessionCost = (cost: number): string =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(cost)

const formatSessionInstant = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value === "") {
    return "—"
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    return value
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(ms)
}

const formatTokenCount = (value: number): string =>
  new Intl.NumberFormat(undefined).format(value)

const variantsForModel = (
  models: readonly AgentModelOption[] | undefined,
  modelId: string,
): readonly string[] => {
  if (modelId.length === 0 || models === undefined) return []
  return models.find((model) => model.id === modelId)?.thinkingLevels ?? []
}

const formatVariantLabel = (variant: string): string =>
  `${variant[0]?.toUpperCase() ?? ""}${variant.slice(1)}`

const reconcileVariantForModel = (
  variant: string,
  modelVariants: readonly string[],
): string =>
  variant.length > 0 && modelVariants.includes(variant) ? variant : ""

export const repositoriesQuery = {
  queryKey: ["repositories"],
  queryFn: async () => {
    // Intentionally omits pullRequestCount: GitHub-authoritative open non-draft
    // PR counting is a dedicated projection (openPullRequestCountsQuery) so
    // Keymaxxer-backed count latency cannot delay Configured Repositories,
    // credentials, Issues, Work Items, or controls.
    const result = await graphql.query({
      repositories: {
        id: true,
        forge: true,
        forgeHost: true,
        projectPath: true,
        localPath: true,
        isBare: true,
        paused: true,
        selectedAgentBackend: true,
        effectiveAgentBackend: true,
        defaultModel: true,
        defaultThinkingLevel: true,
        reviewModel: true,
        reviewThinkingLevel: true,
        autoMerge: true,
        includeAllIssueAuthors: true,
        waitForReadyForReviewChecks: true,
        issuesReconciledAt: true,
        blockingUnfinishedWorkItemCount: true,
      },
      repositoryCredentials: {
        repositoryId: true,
        configured: true,
        githubTokenSecretName: true,
        githubTokenCreationUrl: true,
      },
    })
    return result.repositories.map((repository) => {
      const credential = result.repositoryCredentials.find(
        ({ repositoryId }) => repositoryId === repository.id,
      )
      if (credential === undefined) {
        throw new Error(`Missing credential status for ${repository.id}`)
      }
      return { ...repository, credential }
    })
  },
}

/**
 * Dedicated cache identity for GitHub open non-draft Pull Request counts.
 * Independent of {@link repositoriesQuery}: a slow or failed count must not
 * cancel or block the Configured Repositories projection.
 */
const openPullRequestCountsQuery = {
  queryKey: openPullRequestCountsQueryKey,
  queryFn: async (): Promise<Readonly<Record<string, number>>> => {
    const result = await graphql.query({
      repositories: {
        id: true,
        pullRequestCount: true,
      },
    })
    return Object.fromEntries(
      result.repositories.map(({ id, pullRequestCount }) => [
        id,
        pullRequestCount,
      ]),
    )
  },
}

const addRepositoryCommandQuery = {
  queryKey: ["addRepositoryCommand"],
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  queryFn: async () => {
    const result = await graphql.query({ addRepositoryCommand: true })
    return result.addRepositoryCommand
  },
}

const directoryPickerAvailableQuery = {
  queryKey: ["directoryPickerAvailable"],
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  queryFn: async () => {
    const result = await graphql.query({ directoryPickerAvailable: true })
    return result.directoryPickerAvailable
  },
}

export const issuesQuery = (repositoryId: string) => ({
  queryKey: ["issues", repositoryId],
  queryFn: async () => {
    const result = await graphql.query({
      issues: {
        __args: { repositoryId },
        id: true,
        repositoryId: true,
        issueNumber: true,
        title: true,
        url: true,
        state: true,
        issueAuthor: true,
        parent: {
          issueNumber: true,
          issueUrl: true,
        },
        hasChildren: true,
        blockedBy: {
          issueNumber: true,
          issueUrl: true,
        },
      },
    })
    return result.issues
  },
})

export type Repository = {
  id: string
  forge: string
  forgeHost: string
  projectPath: string
  localPath: string
  isBare: boolean
  paused: boolean
  selectedAgentBackend: string | null
  effectiveAgentBackend: string
  defaultModel: string | null
  defaultThinkingLevel: string | null
  reviewModel: string | null
  reviewThinkingLevel: string | null
  autoMerge: boolean
  includeAllIssueAuthors: boolean
  waitForReadyForReviewChecks: boolean
  issuesReconciledAt: string | null
  blockingUnfinishedWorkItemCount: number
  credential: RepositoryCredential
}

type RepositoryCredential = {
  repositoryId: string
  configured: boolean
  githubTokenSecretName: string
  githubTokenCreationUrl: string
}

type RepositoryIssue = {
  id: string
  repositoryId: string
  issueNumber: number
  title: string
  url: string
  state: "OPEN" | "CLOSED"
  issueAuthor: string | null
  parent: {
    issueNumber: number
    issueUrl: string
  } | null
  hasChildren: boolean
  blockedBy: readonly {
    issueNumber: number
    issueUrl: string
  }[]
}

type WorkItemState = GraphqlWorkItemState

type WorkItemStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "INTERRUPTED"
  | "CANCELLED"
  | "COMPLETE"
  | "ABANDONED"
  | "NEEDS_HUMAN"
  | "NEEDS_HUMAN_REVIEW"
  | "WAITING_FOR_WORKER_SLOT"
  | "WAITING_FOR_BLOCKERS"

export type WorkItem = {
  id: string
  repositoryId: string
  issueNumber: number
  issueTitle: string | null
  pullRequestNumber: number | null
  agentBackend: { id: string; label: string }
  state: WorkItemState
  stateLabel: string
  status: WorkItemStatus
  statusLabel: string
  statusMessage: string | null
  paused: boolean
  canRetry: boolean
  isTerminal: boolean
  failureCode: string | null
  sessionId: string | null
  worktreePath: string | null
  completionSummary: string | null
  createdAt: string
  stateReadyAt: string
  lifecycleLabels: readonly {
    phase: string
    label: string
    status: WorkItemStatus
    durationMs: number | null
  }[]
}

const workItemFields = {
  id: true,
  repositoryId: true,
  issueNumber: true,
  issueTitle: true,
  pullRequestNumber: true,
  agentBackend: { id: true, label: true },
  mergeMode: true,
  state: true,
  stateLabel: true,
  status: true,
  statusLabel: true,
  statusMessage: true,
  paused: true,
  canRetry: true,
  isTerminal: true,
  failureCode: true,
  sessionId: true,
  worktreePath: true,
  completionSummary: true,
  createdAt: true,
  stateReadyAt: true,
  lifecycleLabels: {
    phase: true,
    label: true,
    status: true,
    durationMs: true,
  },
} as const

type WorkItemsListKindArg = "WORKING" | "FAILED" | "COMPLETED"

type WorkItemsQueryOptions = {
  readonly listKind?: WorkItemsListKindArg
  readonly limit?: number
}

/**
 * Rolling window hours for Jobs Completed labels (same source as server filter).
 * Filtering uses Work Item stateReadyAt within JOBS_COMPLETED_WINDOW_MS on the API.
 */
export const JOBS_COMPLETED_WINDOW_HOURS = jobsCompletedWindowHours
/** Failed history window (fixed item cap; independent of Completed). */
export const JOBS_FAILED_LIMIT = 15
/** Historical Completed page size (server-paginated; not the Jobs 24 h tab). */
export const COMPLETED_WORK_ITEMS_PAGE_SIZE = completedWorkItemsDefaultPageSize

export const workItemsQuery = (
  repositoryId: string,
  options: WorkItemsQueryOptions = {},
) => {
  const listKind = options.listKind
  const limit = options.limit
  return {
    queryKey: [
      "work-items",
      repositoryId,
      listKind ?? null,
      limit ?? null,
    ] as const,
    queryFn: async (): Promise<readonly WorkItem[]> => {
      const result = await graphql.query({
        workItems: {
          __args: {
            repositoryId,
            ...(listKind === undefined ? {} : { listKind }),
            ...(limit === undefined ? {} : { limit }),
          },
          ...workItemFields,
        },
      })
      return result.workItems
    },
  }
}

export const jobsWorkingWorkItemsQuery = (repositoryId: string) =>
  workItemsQuery(repositoryId, { listKind: "WORKING" })

export const jobsFailedWorkItemsQuery = (repositoryId: string) =>
  workItemsQuery(repositoryId, {
    listKind: "FAILED",
    limit: JOBS_FAILED_LIMIT,
  })

export const jobsCompletedWorkItemsQuery = (repositoryId: string) =>
  workItemsQuery(repositoryId, {
    listKind: "COMPLETED",
  })

export type CompletedWorkItemsPage = {
  readonly items: readonly WorkItem[]
  readonly page: number
  readonly pageSize: number
  readonly totalCount: number
  readonly hasNextPage: boolean
  readonly hasPreviousPage: boolean
}

/**
 * Historical Completed Work Items across all repositories (server-paginated).
 * Distinct from jobsCompletedWorkItemsQuery (per-repo, 24 h window).
 */
export const completedWorkItemsHistoryQuery = (page: number) => ({
  queryKey: [
    ...completedWorkItemsHistoryQueryKeyPrefix,
    page,
    COMPLETED_WORK_ITEMS_PAGE_SIZE,
  ] as const,
  // Keep the prior page visible while the next page loads so pagination does
  // not flash a full-board skeleton (and so live updates stay mounted).
  placeholderData: keepPreviousData,
  queryFn: async (): Promise<CompletedWorkItemsPage> => {
    const result = await graphql.query({
      completedWorkItems: {
        __args: {
          page,
          pageSize: COMPLETED_WORK_ITEMS_PAGE_SIZE,
        },
        items: workItemFields,
        page: true,
        pageSize: true,
        totalCount: true,
        hasNextPage: true,
        hasPreviousPage: true,
      },
    })
    return result.completedWorkItems
  },
})

const committedPullRequestsCountQuery = (from: string, to: string) => ({
  queryKey: [...committedPullRequestsCountQueryKeyPrefix, from, to] as const,
  queryFn: async (): Promise<number> => {
    const result = await graphql.query({
      committedPullRequestsCount: {
        __args: { from, to },
      },
    })
    return result.committedPullRequestsCount
  },
})

const patchWorkItemsCaches = (
  queryClient: ReturnType<typeof useQueryClient>,
  repositoryId: string,
  update: (
    current: readonly WorkItem[] | undefined,
  ) => readonly WorkItem[] | undefined,
) => {
  for (const [queryKey] of queryClient.getQueriesData<readonly WorkItem[]>({
    queryKey: ["work-items", repositoryId],
  })) {
    queryClient.setQueryData<readonly WorkItem[]>(queryKey, update)
  }
}

export const Route = createFileRoute("/")({
  component: HomePage,
})

/**
 * Home is the kanban board when repositories exist; otherwise the same
 * add-repo blank slate as `/repos` (no empty pipeline).
 *
 * Membership SSE stays mounted on both paths so CLI add/remove refreshes the
 * blank-slate ↔ board gate without navigating away (issue #684 review).
 */
function HomePage() {
  return (
    <>
      <HomeRepositoryMembershipLive />
      <HomeContent />
    </>
  )
}

/**
 * Transport-health membership subscription for `/`. Board issues/work-items
 * live updates stay on `KanbanLiveUpdates`; `/repos` owns its own copy via
 * `RepositoryCards`.
 */
function HomeRepositoryMembershipLive() {
  const queryClient = useQueryClient()
  const [liveUpdatesUnavailable, setLiveUpdatesUnavailable] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      onLiveUpdatesUnavailable: setLiveUpdatesUnavailable,
    })
    return () => controller.abort()
  }, [queryClient])

  const warningPresentation = liveUpdatesWarningPresentation(
    liveUpdatesUnavailable,
  )
  if (warningPresentation === null) {
    return null
  }
  return (
    <Banner className="mb-4" tone="alarm" tag="Live">
      {warningPresentation.message}
    </Banner>
  )
}

function HomeContent() {
  // Soft-fail repositories so a load error cannot unmount home chrome
  // (Suspense only catches promises; there is no route ErrorBoundary).
  const {
    data: repositories,
    isPending,
    isError,
    refetch,
  } = useQuery(repositoriesQuery)

  if (isPending && repositories === undefined) {
    return (
      <main className="pt-8 sm:pt-10">
        <div
          className="grid gap-3"
          role="status"
          aria-label="Loading home"
          aria-busy="true"
        >
          <span className="block h-10 w-[40%] animate-pulse bg-paper-2 motion-reduce:animate-none" />
          <span className="block h-24 animate-pulse bg-paper-2 motion-reduce:animate-none" />
        </div>
      </main>
    )
  }

  if (isError && repositories === undefined) {
    return (
      <main className="pt-8 sm:pt-10">
        <Banner
          tone="alarm"
          tag="Error"
          role="alert"
          action={
            <BannerActionButton
              onClick={() => {
                void refetch()
              }}
            >
              Retry
            </BannerActionButton>
          }
        >
          Could not load repositories. Please try again.
        </Banner>
      </main>
    )
  }

  if ((repositories ?? []).length === 0) {
    return (
      <main className="pt-8 sm:pt-10">
        <Suspense
          fallback={
            <div
              className="grid gap-3"
              role="status"
              aria-label="Loading add repository guidance"
              aria-busy="true"
            >
              <span className="block h-10 w-[50%] animate-pulse bg-paper-2 motion-reduce:animate-none" />
              <span className="block h-32 animate-pulse bg-paper-2 motion-reduce:animate-none" />
            </div>
          }
        >
          <EmptyRepositoriesBlankSlate />
        </Suspense>
      </main>
    )
  }
  return <KanbanBoard />
}

/** Shared zero-repo blank slate used by `/` and `/repos`. */
function EmptyRepositoriesBlankSlate() {
  const { data: addRepositoryCommand } = useSuspenseQuery(
    addRepositoryCommandQuery,
  )
  return (
    <AddRepositoryGuidance
      command={addRepositoryCommand}
      heading="No repositories configured"
    />
  )
}

export function CommittedPullRequestsDashboard() {
  const [bounds, setBounds] = useState(() =>
    localCommittedPullRequestDayBounds(),
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const syncBounds = () => {
      const next = localCommittedPullRequestDayBounds()
      setBounds((current) =>
        current.todayFrom === next.todayFrom && current.todayTo === next.todayTo
          ? current
          : next,
      )
    }
    const scheduleMidnightRollover = () => {
      timer = setTimeout(() => {
        syncBounds()
        scheduleMidnightRollover()
      }, msUntilNextLocalMidnight())
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") syncBounds()
    }
    scheduleMidnightRollover()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  const todayQuery = useQuery(
    committedPullRequestsCountQuery(bounds.todayFrom, bounds.todayTo),
  )
  const yesterdayQuery = useQuery(
    committedPullRequestsCountQuery(bounds.yesterdayFrom, bounds.yesterdayTo),
  )
  const thisWeekQuery = useQuery(
    committedPullRequestsCountQuery(bounds.thisWeekFrom, bounds.thisWeekTo),
  )
  const lastWeekQuery = useQuery(
    committedPullRequestsCountQuery(bounds.lastWeekFrom, bounds.lastWeekTo),
  )
  const twoWeeksAgoQuery = useQuery(
    committedPullRequestsCountQuery(
      bounds.twoWeeksAgoFrom,
      bounds.twoWeeksAgoTo,
    ),
  )
  const loading =
    todayQuery.isLoading ||
    yesterdayQuery.isLoading ||
    thisWeekQuery.isLoading ||
    lastWeekQuery.isLoading ||
    twoWeeksAgoQuery.isLoading
  const failed =
    todayQuery.isError ||
    yesterdayQuery.isError ||
    thisWeekQuery.isError ||
    lastWeekQuery.isError ||
    twoWeeksAgoQuery.isError

  if (loading) {
    return (
      <article
        className="merged-pr-stats"
        role="status"
        aria-label="Loading committed pull requests"
        aria-busy="true"
      >
        <header className="merged-pr-stats-head">
          <span className="merged-pr-stats-tag">Merged</span>
          <h2 className="merged-pr-stats-title">Merged PR throughput</h2>
          <span className="merged-pr-stats-note">
            Qty per period · local time
          </span>
        </header>
        <div className="merged-pr-stats-grid">
          <div className="merged-pr-stats-cell">
            <span className="merged-pr-stats-skeleton animate-pulse motion-reduce:animate-none" />
          </div>
          <div className="merged-pr-stats-cell">
            <span className="merged-pr-stats-skeleton animate-pulse motion-reduce:animate-none" />
          </div>
          <div className="merged-pr-stats-cell">
            <span className="merged-pr-stats-skeleton animate-pulse motion-reduce:animate-none" />
          </div>
          <div className="merged-pr-stats-cell">
            <span className="merged-pr-stats-skeleton animate-pulse motion-reduce:animate-none" />
          </div>
          <div className="merged-pr-stats-cell">
            <span className="merged-pr-stats-skeleton animate-pulse motion-reduce:animate-none" />
          </div>
        </div>
      </article>
    )
  }

  if (failed) {
    return (
      <article className="merged-pr-stats">
        <header className="merged-pr-stats-head">
          <span className="merged-pr-stats-tag">Merged</span>
          <h2 className="merged-pr-stats-title">Merged PR throughput</h2>
        </header>
        <div className="merged-pr-stats-body">
          <Banner
            tone="alarm"
            tag="Error"
            role="alert"
            className="banner--compact"
          >
            Could not load committed pull requests. Please try again.
          </Banner>
        </div>
      </article>
    )
  }

  const today = todayQuery.data ?? 0
  const yesterday = yesterdayQuery.data ?? 0
  const thisWeek = thisWeekQuery.data ?? 0
  const lastWeek = lastWeekQuery.data ?? 0
  const twoWeeksAgo = twoWeeksAgoQuery.data ?? 0

  return (
    <article className="merged-pr-stats">
      <header className="merged-pr-stats-head">
        <span className="merged-pr-stats-tag">Merged</span>
        <h2 className="merged-pr-stats-title">Merged PR throughput</h2>
        <span className="merged-pr-stats-note">
          Qty per period · local time
        </span>
      </header>
      <div className="merged-pr-stats-grid">
        <div className="merged-pr-stats-cell">
          <span className="merged-pr-stats-num">{today}</span>
          <span className="merged-pr-stats-label">Today</span>
        </div>
        <div className="merged-pr-stats-cell">
          <span className="merged-pr-stats-num">{yesterday}</span>
          <span className="merged-pr-stats-label">Yesterday</span>
        </div>
        <div className="merged-pr-stats-cell">
          <span className="merged-pr-stats-num">{thisWeek}</span>
          <span className="merged-pr-stats-label">This week</span>
        </div>
        <div className="merged-pr-stats-cell">
          <span className="merged-pr-stats-num">{lastWeek}</span>
          <span className="merged-pr-stats-label">Last week</span>
        </div>
        <div className="merged-pr-stats-cell">
          <span className="merged-pr-stats-num">{twoWeeksAgo}</span>
          <span className="merged-pr-stats-label">Two weeks ago</span>
        </div>
      </div>
    </article>
  )
}

export function RepositoryCards() {
  const queryClient = useQueryClient()
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)
  const { data: addRepositoryCommand } = useSuspenseQuery(
    addRepositoryCommandQuery,
  )
  // Populated footer only; empty state uses EmptyRepositoriesBlankSlate.
  const [liveUpdatesUnavailable, setLiveUpdatesUnavailable] = useState(false)
  const [issuesChangeCounts, setIssuesChangeCounts] = useState<
    Readonly<Record<string, number>>
  >({})
  const repositoryIdsRef = useRef(repositories.map(({ id }) => id))
  repositoryIdsRef.current = repositories.map(({ id }) => id)

  // Repository membership SSE: transport health drives the live-updates
  // warning; authoritative catch-up and dedicated open-PR counts run
  // independently and cannot mark a healthy stream unavailable.
  useEffect(() => {
    const controller = new AbortController()
    void followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      onLiveUpdatesUnavailable: setLiveUpdatesUnavailable,
    })
    return () => controller.abort()
  }, [queryClient])

  useEffect(() => {
    const controller = new AbortController()
    void followRepositoryIssuesLive({
      getRepositoryIds: () => repositoryIdsRef.current,
      onRepositoryChanged: (repositoryId) => {
        setIssuesChangeCounts((counts) => ({
          ...counts,
          [repositoryId]: (counts[repositoryId] ?? 0) + 1,
        }))
      },
      queryClient,
      queries: {
        repositories: repositoriesQuery,
        issues: issuesQuery,
        workItems: workItemsQuery,
      },
      signal: controller.signal,
    })
    return () => controller.abort()
  }, [queryClient])

  useEffect(() => {
    const controller = new AbortController()
    void followRepositoryWorkItemsLive({
      getRepositoryIds: () => repositoryIdsRef.current,
      queryClient,
      queries: {
        workItems: workItemsQuery,
      },
      signal: controller.signal,
    })
    return () => controller.abort()
  }, [queryClient])

  // GitHub-authoritative open non-draft PR header counts: dedicated projection
  // only — poll while visible and refetch when a backgrounded tab returns
  // (external PRs do not emit Work Item SSE events). Never touches repositoriesQuery.
  useEffect(() => {
    const controller = new AbortController()
    void followOpenPullRequestCountLive({
      queryClient,
      openPullRequestCountsQuery,
      signal: controller.signal,
    })
    return () => controller.abort()
  }, [queryClient])

  const warningPresentation = liveUpdatesWarningPresentation(
    liveUpdatesUnavailable,
  )
  const warning =
    warningPresentation !== null ? (
      <Banner className="mb-4" tone="alarm" tag="Live">
        {warningPresentation.message}
      </Banner>
    ) : null

  if (repositories.length === 0) {
    return (
      <>
        {warning}
        <EmptyRepositoriesBlankSlate />
      </>
    )
  }

  return (
    <>
      {warning}
      <section
        className="grid grid-cols-1 gap-12 sm:gap-16"
        aria-label="Configured repositories"
      >
        {repositories.map((repository) => (
          <RepositoryCard
            issuesChangeCount={issuesChangeCounts[repository.id] ?? 0}
            key={repository.id}
            repository={repository}
          />
        ))}
      </section>
      <div className="mt-12 sm:mt-16">
        <AddRepositoryGuidance command={addRepositoryCommand} />
      </div>
    </>
  )
}

function AddRepositoryGuidance({
  command,
  heading,
}: {
  command: string
  heading?: string
}) {
  const queryClient = useQueryClient()
  // Non-suspense: default false hides Browse until known so parent Repos
  // Suspense is not re-triggered after repositories/command already painted.
  const { data: directoryPickerAvailable = false } = useQuery(
    directoryPickerAvailableQuery,
  )
  const [path, setPath] = useState("")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [inspection, setInspection] = useState<{
    forge: "github" | "gitlab"
    forgeHost: string
    projectPath: string
    localPath: string
    isBare: boolean
  } | null>(null)
  // Bridges pick→add so controls stay disabled across the handoff.
  const [pickToAddBridging, setPickToAddBridging] = useState(false)

  const addLocalRepository = useMutation({
    mutationFn: async (input: NonNullable<typeof inspection>) => {
      const result = await graphql.mutation({
        addRepository: {
          __args: {
            input: {
              forge: input.forge,
              forgeHost: input.forgeHost.trim(),
              projectPath: input.projectPath.trim(),
              localPath: input.localPath,
              isBare: input.isBare,
            },
          },
          id: true,
          forge: true,
          forgeHost: true,
          projectPath: true,
          localPath: true,
          isBare: true,
          paused: true,
          selectedAgentBackend: true,
          effectiveAgentBackend: true,
          defaultModel: true,
          defaultThinkingLevel: true,
          reviewModel: true,
          reviewThinkingLevel: true,
          autoMerge: true,
          includeAllIssueAuthors: true,
          waitForReadyForReviewChecks: true,
          issuesReconciledAt: true,
          blockingUnfinishedWorkItemCount: true,
        },
      })
      return result.addRepository
    },
    onSuccess: async () => {
      setErrorMessage(null)
      setPath("")
      setInspection(null)
      await queryClient.invalidateQueries({
        queryKey: repositoriesQuery.queryKey,
      })
      void queryClient.invalidateQueries({
        queryKey: openPullRequestCountsQuery.queryKey,
      })
    },
    onError: (error) => {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not add repository. Check the path and try again.",
      )
    },
    onSettled: () => {
      setPickToAddBridging(false)
    },
  })

  const inspectLocalRepository = useMutation({
    mutationFn: async (localPath: string) => {
      const result = await graphql.mutation({
        inspectLocalRepository: {
          __args: { path: localPath },
          forge: true,
          forgeHost: true,
          projectPath: true,
          localPath: true,
          isBare: true,
        },
      })
      return result.inspectLocalRepository
    },
    onSuccess: (result) => {
      setInspection({
        ...result,
        forge: result.forge === "gitlab" ? "gitlab" : "github",
      })
      setErrorMessage(null)
    },
    onError: (error) => {
      setInspection(null)
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not inspect repository. Check the path and try again.",
      )
    },
    onSettled: () => {
      setPickToAddBridging(false)
    },
  })

  const pickDirectory = useMutation({
    mutationFn: async () => {
      const result = await graphqlUnbatched.mutation({
        pickLocalDirectory: true,
      })
      return result.pickLocalDirectory
    },
    onSuccess: (picked) => {
      // Cancel or unavailable dialog: no-op (no error toast).
      if (picked === null || picked === undefined || picked.length === 0) {
        return
      }
      setPickToAddBridging(true)
      setPath(picked)
      setInspection(null)
      setErrorMessage(null)
      inspectLocalRepository.mutate(picked)
    },
    onError: () => {
      // Transport/server failures only — cancel maps to null in onSuccess.
      setPickToAddBridging(false)
      setErrorMessage("Could not open the folder dialog. Enter a path instead.")
    },
  })

  const busy =
    addLocalRepository.isPending ||
    inspectLocalRepository.isPending ||
    pickDirectory.isPending ||
    pickToAddBridging

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = path.trim()
    if (trimmed.length === 0) {
      setErrorMessage("Enter a path to a local Git repository.")
      return
    }
    setErrorMessage(null)
    if (inspection === null) {
      setInspection(null)
      inspectLocalRepository.mutate(trimmed)
      return
    }
    addLocalRepository.mutate(inspection)
  }

  return (
    <section
      className="border border-dashed border-rule-2 bg-panel px-6 py-12 text-center sm:px-10"
      aria-label="Add a repository"
    >
      {heading !== undefined ? (
        <h2 className="m-0 font-serif text-2xl font-semibold text-ink">
          {heading}
        </h2>
      ) : null}
      <form
        className={`mx-auto flex w-full max-w-xl flex-col gap-3 ${heading !== undefined ? "mt-6" : "mt-0"}`}
        onSubmit={onSubmit}
      >
        <label className="sr-only" htmlFor="add-repository-path">
          Local repository path
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
          <input
            id="add-repository-path"
            type="text"
            value={path}
            onChange={(event) => {
              setPath(event.target.value)
              setInspection(null)
              if (errorMessage !== null) {
                setErrorMessage(null)
              }
            }}
            placeholder="/path/to/local/repo"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            className="min-w-0 flex-1 border border-rule-2 bg-paper px-3 py-2 font-mono text-sm text-ink-2 placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood disabled:opacity-60"
          />
          <div className="flex shrink-0 gap-2">
            {directoryPickerAvailable ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => pickDirectory.mutate()}
                className="border border-rule-2 bg-panel px-3 py-2 text-sm font-semibold text-ink-2 transition hover:border-ink-soft hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood disabled:cursor-wait disabled:opacity-60"
              >
                {pickDirectory.isPending ? "Browsing…" : "Browse…"}
              </button>
            ) : null}
            <button
              type="submit"
              disabled={busy}
              className="bg-oxblood px-3 py-2 text-sm font-semibold tracking-wide text-on-solid uppercase transition hover:bg-oxblood-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood disabled:cursor-wait disabled:opacity-60"
            >
              {addLocalRepository.isPending
                ? "Adding…"
                : inspectLocalRepository.isPending
                  ? "Inspecting…"
                  : inspection === null
                    ? "Inspect"
                    : "Confirm and add"}
            </button>
          </div>
        </div>
        {inspection !== null ? (
          <fieldset className="grid gap-3 border border-rule p-4 text-left">
            <legend className="px-1 font-mono text-xs font-semibold tracking-[0.16em] text-ink-faint uppercase">
              Confirm forge identity
            </legend>
            <label className="grid gap-1 text-sm font-semibold text-ink-2">
              Forge
              <select
                className="border border-rule-2 bg-paper px-3 py-2 font-normal"
                value={inspection.forge}
                onChange={(event) =>
                  setInspection({
                    ...inspection,
                    forge: event.target.value as "github" | "gitlab",
                  })
                }
              >
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm font-semibold text-ink-2">
              Forge host
              <input
                className="border border-rule-2 bg-paper px-3 py-2 font-mono font-normal"
                required
                value={inspection.forgeHost}
                onChange={(event) =>
                  setInspection({
                    ...inspection,
                    forgeHost: event.target.value,
                  })
                }
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-ink-2">
              Project path
              <input
                className="border border-rule-2 bg-paper px-3 py-2 font-mono font-normal"
                required
                value={inspection.projectPath}
                onChange={(event) =>
                  setInspection({
                    ...inspection,
                    projectPath: event.target.value,
                  })
                }
              />
            </label>
            <p className="m-0 text-xs text-ink-faint">
              The project is verified against this forge before it is saved.
            </p>
          </fieldset>
        ) : null}
        {errorMessage !== null ? (
          <p className="m-0 text-left text-sm text-oxblood-deep" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </form>
      <p
        className="mt-8 mb-0 text-center text-xs tracking-[0.18em] text-ink-faint uppercase"
        aria-hidden="true"
      >
        --- or ---
      </p>
      <p className="mt-6 text-sm text-ink-soft">
        Add a local Git repository with the operator binary:
      </p>
      <code className="mt-4 inline-block max-w-full overflow-x-auto border border-rule-2 bg-paper px-3 py-2 font-mono text-sm text-ink-2">
        {command}
      </code>
    </section>
  )
}

function RepositoryCard({
  issuesChangeCount,
  repository,
}: {
  issuesChangeCount: number
  repository: Repository
}) {
  const queryClient = useQueryClient()
  const [githubTokenCreated, setGithubTokenCreated] = useState(false)
  const [gitlabTokenCreated, setGitlabTokenCreated] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [awaitingRefresh, setAwaitingRefresh] = useState(false)
  const issuesChangeCountOnRefresh = useRef(issuesChangeCount)
  const settingsDialogRef = useRef<HTMLDialogElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const config = useQuery({ ...configQuery, enabled: settingsOpen })
  const models = useQuery({ ...modelsQuery, enabled: settingsOpen })
  const agentBackends = useQuery({
    ...agentBackendsQuery,
    enabled: settingsOpen,
  })
  const [forge, setForge] = useState<"github" | "gitlab">(
    repository.forge === "gitlab" ? "gitlab" : "github",
  )
  const [forgeHost, setForgeHost] = useState(repository.forgeHost)
  const [projectPath, setProjectPath] = useState(repository.projectPath)
  const [paused, setPaused] = useState(repository.paused)
  // null override = inherit harness default; select value is "" for inherit.
  const [selectedAgentBackend, setSelectedAgentBackend] = useState<
    string | null
  >(repository.selectedAgentBackend)
  const [defaultModel, setDefaultModel] = useState(
    repository.defaultModel ?? "",
  )
  const [defaultThinkingLevel, setDefaultVariant] = useState(
    repository.defaultThinkingLevel ?? "",
  )
  const [reviewModel, setReviewModel] = useState(repository.reviewModel ?? "")
  const [reviewThinkingLevel, setReviewVariant] = useState(
    repository.reviewThinkingLevel ?? "",
  )
  const [autoMerge, setAutoMerge] = useState(repository.autoMerge)
  const [includeAllIssueAuthors, setIncludeAllIssueAuthors] = useState(
    repository.includeAllIssueAuthors,
  )
  const [waitForReadyForReviewChecks, setWaitForReadyForReviewChecks] =
    useState(repository.waitForReadyForReviewChecks)
  const [previewModels, setPreviewModels] = useState<
    readonly AgentModelOption[] | null
  >(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewPending, setPreviewPending] = useState(false)
  const [harnessPrefsForDraft, setHarnessPrefsForDraft] = useState<{
    defaultModel: string | null
    defaultThinkingLevel: string | null
    reviewModel: string | null
    reviewThinkingLevel: string | null
  } | null>(null)
  const previewGenerationRef = useRef(0)
  // Dialog-session stash so switching backends and back restores form fields.
  // Server map for non-projected backends needs repositoryModelPrefs (not in API).
  type DraftModelPrefs = {
    defaultModel: string | null
    defaultThinkingLevel: string | null
    reviewModel: string | null
    reviewThinkingLevel: string | null
  }
  const draftPrefsByBackendRef = useRef<Record<string, DraftModelPrefs>>({})
  const jobsQuery = workItemsQuery(repository.id)
  const { data: workItems = [], isLoading: workItemsLoading } =
    useQuery(jobsQuery)

  const updateSettings = useMutation({
    mutationFn: async (input: {
      repositoryId: string
      forge: "github" | "gitlab"
      forgeHost: string
      projectPath: string
      paused: boolean
      selectedAgentBackend: string | null
      defaultModel: string | null
      defaultThinkingLevel: string | null
      reviewModel: string | null
      reviewThinkingLevel: string | null
      autoMerge: boolean
      includeAllIssueAuthors: boolean
      waitForReadyForReviewChecks: boolean
    }) => {
      const result = await graphql.mutation({
        updateRepositorySettings: {
          __args: { input },
          id: true,
          forge: true,
          forgeHost: true,
          projectPath: true,
          localPath: true,
          isBare: true,
          paused: true,
          selectedAgentBackend: true,
          effectiveAgentBackend: true,
          defaultModel: true,
          defaultThinkingLevel: true,
          reviewModel: true,
          reviewThinkingLevel: true,
          autoMerge: true,
          includeAllIssueAuthors: true,
          waitForReadyForReviewChecks: true,
          issuesReconciledAt: true,
          blockingUnfinishedWorkItemCount: true,
        },
      })
      return result.updateRepositorySettings
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<readonly Repository[]>(
        repositoriesQuery.queryKey,
        (repositories) =>
          repositories?.map((candidate) =>
            candidate.id === updated.id
              ? { ...candidate, ...updated }
              : candidate,
          ),
      )
      // Override changes can expand/shrink the Active Agent Backend set.
      void queryClient.invalidateQueries({
        queryKey: ["agentBackendStatus"],
      })
      void queryClient.invalidateQueries({
        queryKey: repositoriesQuery.queryKey,
      })
      settingsDialogRef.current?.close()
      setSettingsOpen(false)
    },
  })

  const applyRepoModelPrefs = (prefs: DraftModelPrefs) => {
    setDefaultModel(prefs.defaultModel ?? "")
    setDefaultVariant(prefs.defaultThinkingLevel ?? "")
    setReviewModel(prefs.reviewModel ?? "")
    setReviewVariant(prefs.reviewThinkingLevel ?? "")
  }

  const currentDraftModelPrefs = (): DraftModelPrefs => ({
    defaultModel: defaultModel.trim() === "" ? null : defaultModel,
    defaultThinkingLevel:
      defaultThinkingLevel.trim() === "" ? null : defaultThinkingLevel,
    reviewModel: reviewModel.trim() === "" ? null : reviewModel,
    reviewThinkingLevel:
      reviewThinkingLevel.trim() === "" ? null : reviewThinkingLevel,
  })

  const draftEffectiveBackend = (
    override: string | null,
    harnessDefault: string,
  ): string => override ?? harnessDefault

  const applyAgentBackendSelection = (nextSelectValue: string) => {
    const nextOverride =
      nextSelectValue === HARNESS_DEFAULT_BACKEND_VALUE ? null : nextSelectValue
    const harnessDefault = config.data?.selectedAgentBackend ?? "opencode"
    const previousEffective = draftEffectiveBackend(
      selectedAgentBackend,
      harnessDefault,
    )
    const nextEffective = draftEffectiveBackend(nextOverride, harnessDefault)
    const savedEffective = repository.effectiveAgentBackend

    // Stash form fields for the backend we are leaving so switching back in
    // this dialog session restores them (harness Settings does this via prefs).
    draftPrefsByBackendRef.current[previousEffective] = currentDraftModelPrefs()

    setSelectedAgentBackend(nextOverride)

    // Clear catalog/pending synchronously (before useEffect) so Save cannot
    // validate against the previous override's catalog for a render frame.
    // Bump generation so any in-flight preview is ignored when the effect runs.
    previewGenerationRef.current += 1
    if (nextEffective === harnessDefault) {
      setPreviewPending(false)
      setPreviewError(null)
      setPreviewModels(null)
      setHarnessPrefsForDraft(null)
    } else {
      setPreviewPending(true)
      setPreviewError(null)
      setPreviewModels(null)
      setHarnessPrefsForDraft(null)
    }

    const stashed = draftPrefsByBackendRef.current[nextEffective]
    if (stashed !== undefined) {
      applyRepoModelPrefs(stashed)
    } else if (nextEffective === savedEffective) {
      applyRepoModelPrefs({
        defaultModel: repository.defaultModel,
        defaultThinkingLevel: repository.defaultThinkingLevel,
        reviewModel: repository.reviewModel,
        reviewThinkingLevel: repository.reviewThinkingLevel,
      })
    } else {
      // No session stash and no projected flat columns for this effective
      // backend — empty means inherit harness until the operator picks models.
      applyRepoModelPrefs({
        defaultModel: null,
        defaultThinkingLevel: null,
        reviewModel: null,
        reviewThinkingLevel: null,
      })
    }
  }

  const openSettings = () => {
    setSettingsOpen(true)
    previewGenerationRef.current += 1
    setPaused(repository.paused)
    setForge(repository.forge === "gitlab" ? "gitlab" : "github")
    setForgeHost(repository.forgeHost)
    setProjectPath(repository.projectPath)
    setSelectedAgentBackend(repository.selectedAgentBackend)
    setDefaultModel(repository.defaultModel ?? "")
    setDefaultVariant(repository.defaultThinkingLevel ?? "")
    setReviewModel(repository.reviewModel ?? "")
    setReviewVariant(repository.reviewThinkingLevel ?? "")
    setAutoMerge(repository.autoMerge)
    setIncludeAllIssueAuthors(repository.includeAllIssueAuthors)
    setWaitForReadyForReviewChecks(repository.waitForReadyForReviewChecks)
    setPreviewModels(null)
    setPreviewError(null)
    // Override catalogs load via preview; start pending so model fields stay
    // disabled until the effect loads the correct catalog.
    setPreviewPending(repository.selectedAgentBackend !== null)
    setHarnessPrefsForDraft(null)
    // Seed session stash with the saved effective projection.
    draftPrefsByBackendRef.current = {
      [repository.effectiveAgentBackend]: {
        defaultModel: repository.defaultModel,
        defaultThinkingLevel: repository.defaultThinkingLevel,
        reviewModel: repository.reviewModel,
        reviewThinkingLevel: repository.reviewThinkingLevel,
      },
    }
    updateSettings.reset()
    // Fresh gate counts for backend change (work-item live also refreshes this).
    void queryClient.invalidateQueries({
      queryKey: repositoriesQuery.queryKey,
    })
    if (config.isError) void config.refetch()
    if (models.isError) void models.refetch()
    if (agentBackends.isError) void agentBackends.refetch()
    settingsDialogRef.current?.showModal()
  }

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    updateSettings.mutate({
      repositoryId: repository.id,
      forge,
      forgeHost: forgeHost.trim(),
      projectPath: projectPath.trim(),
      paused,
      selectedAgentBackend,
      defaultModel: defaultModel.trim() === "" ? null : defaultModel,
      defaultThinkingLevel:
        defaultThinkingLevel.trim() === "" ? null : defaultThinkingLevel,
      reviewModel: reviewModel.trim() === "" ? null : reviewModel,
      reviewThinkingLevel:
        reviewThinkingLevel.trim() === "" ? null : reviewThinkingLevel,
      autoMerge,
      includeAllIssueAuthors,
      waitForReadyForReviewChecks,
    })
  }

  const harnessDefaultBackendId =
    config.data?.selectedAgentBackend ?? "opencode"
  const harnessDefaultBackendLabel =
    (agentBackends.data ?? []).find(
      (backend: AgentBackendInfo) => backend.id === harnessDefaultBackendId,
    )?.label ?? harnessDefaultBackendId
  const draftEffective = draftEffectiveBackend(
    selectedAgentBackend,
    harnessDefaultBackendId,
  )
  const savedEffective = repository.effectiveAgentBackend
  const backendDraftChanging = draftEffective !== savedEffective
  const backendChangeBlocked = repository.blockingUnfinishedWorkItemCount > 0

  // Override / draft backends cannot use the harness-default models query.
  // Depend only on selectedAgentBackend (not whole config.data) so live config
  // refetches that only update unfinished counts do not thrash preview.
  const harnessDefaultBackendFromConfig =
    config.data?.selectedAgentBackend ?? null
  useEffect(() => {
    if (!settingsOpen || harnessDefaultBackendFromConfig === null) {
      return
    }
    const harnessDefault = harnessDefaultBackendFromConfig
    const effective = selectedAgentBackend ?? harnessDefault
    if (effective === harnessDefault) {
      setHarnessPrefsForDraft(null)
      setPreviewModels(null)
      setPreviewError(null)
      setPreviewPending(false)
      return
    }
    const generation = ++previewGenerationRef.current
    setPreviewPending(true)
    setPreviewError(null)
    // Drop previous backend's harness prefs / catalog so inherit labels do not
    // briefly show the wrong backend while the new preview loads.
    setHarnessPrefsForDraft(null)
    setPreviewModels(null)
    void (async () => {
      try {
        const [prefsResult, previewResult] = await Promise.all([
          graphql.query({
            harnessModelPrefs: {
              __args: { backendId: effective },
              defaultModel: true,
              defaultThinkingLevel: true,
              reviewModel: true,
              reviewThinkingLevel: true,
            },
          }),
          graphql.query({
            previewAgentBackend: {
              __args: { backendId: effective },
              backend: { id: true, label: true },
              kind: true,
              reason: true,
              models: { id: true, thinkingLevels: true },
            },
          }),
        ])
        if (generation !== previewGenerationRef.current) {
          return
        }
        setHarnessPrefsForDraft(prefsResult.harnessModelPrefs)
        const preview = previewResult.previewAgentBackend
        if (preview.kind === "READY") {
          setPreviewModels(preview.models)
          setPreviewError(null)
        } else {
          setPreviewModels([])
          setPreviewError(
            preview.reason ??
              "Could not load model catalog for the selected Agent Backend",
          )
        }
      } catch (error) {
        if (generation !== previewGenerationRef.current) {
          return
        }
        setPreviewModels([])
        setPreviewError(
          error instanceof Error
            ? error.message
            : "Could not preview the selected Agent Backend",
        )
      } finally {
        if (generation === previewGenerationRef.current) {
          setPreviewPending(false)
        }
      }
    })()
  }, [settingsOpen, harnessDefaultBackendFromConfig, selectedAgentBackend])

  const inheritHarnessBuildModel = (): string => {
    if (harnessPrefsForDraft !== null) {
      return harnessPrefsForDraft.defaultModel ?? "not configured"
    }
    if (draftEffective === harnessDefaultBackendId) {
      return config.data?.defaultModel ?? "not configured"
    }
    return "not configured"
  }
  const inheritHarnessBuildVariant = (): string => {
    if (harnessPrefsForDraft !== null) {
      return harnessPrefsForDraft.defaultThinkingLevel ?? "not configured"
    }
    if (draftEffective === harnessDefaultBackendId) {
      return config.data?.defaultThinkingLevel ?? "not configured"
    }
    return "not configured"
  }
  const harnessDefaultModel = inheritHarnessBuildModel()
  const harnessDefaultVariant = inheritHarnessBuildVariant()
  const resolvedBuildModel =
    defaultModel.length > 0 ? defaultModel : harnessDefaultModel
  const resolvedBuildVariant =
    defaultThinkingLevel.length > 0
      ? defaultThinkingLevel
      : harnessDefaultVariant
  const inheritHarnessReviewModel = (): string => {
    if (harnessPrefsForDraft !== null) {
      return harnessPrefsForDraft.reviewModel ?? `Build (${resolvedBuildModel})`
    }
    if (draftEffective === harnessDefaultBackendId) {
      return config.data?.reviewModel ?? `Build (${resolvedBuildModel})`
    }
    return `Build (${resolvedBuildModel})`
  }
  const inheritHarnessReviewVariant = (): string => {
    if (harnessPrefsForDraft !== null) {
      return (
        harnessPrefsForDraft.reviewThinkingLevel ??
        `Build (${resolvedBuildVariant})`
      )
    }
    if (draftEffective === harnessDefaultBackendId) {
      return (
        config.data?.reviewThinkingLevel ?? `Build (${resolvedBuildVariant})`
      )
    }
    return `Build (${resolvedBuildVariant})`
  }
  const harnessReviewModel = inheritHarnessReviewModel()
  const harnessReviewVariant = inheritHarnessReviewVariant()

  // Global models query catalogs only the harness default backend. Effective
  // override catalogs (saved or draft) come from Preview.
  const usesPreviewCatalog = draftEffective !== harnessDefaultBackendId
  const catalogModels: readonly AgentModelOption[] | undefined =
    usesPreviewCatalog ? (previewModels ?? undefined) : models.data
  const modelIds = (catalogModels ?? []).map((model) => model.id)
  const harnessBuildForSource =
    harnessDefaultModel !== "not configured" ? harnessDefaultModel : ""
  const harnessReviewForSource = !harnessReviewModel.startsWith("Build (")
    ? harnessReviewModel
    : ""
  const buildVariantSourceModel =
    defaultModel.length > 0 ? defaultModel : harnessBuildForSource
  const reviewThinkingLevelSourceModel =
    reviewModel.length > 0
      ? reviewModel
      : defaultModel.length > 0
        ? defaultModel
        : harnessReviewForSource.length > 0
          ? harnessReviewForSource
          : harnessBuildForSource
  const buildVariants = variantsForModel(catalogModels, buildVariantSourceModel)
  const reviewThinkingLevels = variantsForModel(
    catalogModels,
    reviewThinkingLevelSourceModel,
  )
  const hasUnavailableBuildModel =
    defaultModel.length > 0 && !modelIds.includes(defaultModel)
  const hasUnavailableReviewModel =
    reviewModel.length > 0 && !modelIds.includes(reviewModel)
  const buildVariantSourceUnavailable =
    buildVariantSourceModel.length > 0 &&
    !modelIds.includes(buildVariantSourceModel)
  const reviewThinkingLevelSourceUnavailable =
    reviewThinkingLevelSourceModel.length > 0 &&
    !modelIds.includes(reviewThinkingLevelSourceModel)
  const hasCustomBuildVariant =
    defaultThinkingLevel.length > 0 &&
    (buildVariantSourceUnavailable ||
      !buildVariants.includes(defaultThinkingLevel))
  const hasCustomReviewVariant =
    reviewThinkingLevel.length > 0 &&
    (reviewThinkingLevelSourceUnavailable ||
      !reviewThinkingLevels.includes(reviewThinkingLevel))
  const modelsDisabled =
    usesPreviewCatalog && (previewPending || previewError !== null)
  const modelsLoading =
    settingsOpen &&
    (usesPreviewCatalog
      ? previewPending || config.isPending
      : models.isPending || config.isPending || agentBackends.isPending)
  // Only enforce "model not in catalog" when a catalog actually loaded.
  // Failed/pending override preview leaves modelIds empty and must not block
  // non-model saves for the current effective backend.
  const catalogReadyForModelValidation = usesPreviewCatalog
    ? !previewPending && previewError === null && previewModels !== null
    : !models.isPending && !models.isError && models.data !== undefined
  const blockSaveForUnavailableBuildModel =
    catalogReadyForModelValidation &&
    defaultModel.length > 0 &&
    hasUnavailableBuildModel

  const removeRepository = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        removeRepository: { __args: { repositoryId: repository.id } },
      })
      return result.removeRepository
    },
    onSuccess: async (repositoryId) => {
      await queryClient.cancelQueries({ queryKey: repositoriesQuery.queryKey })
      queryClient.setQueryData<readonly Repository[]>(
        repositoriesQuery.queryKey,
        (repositories) => repositories?.filter(({ id }) => id !== repositoryId),
      )
      queryClient.removeQueries({ queryKey: ["issues", repositoryId] })
      await queryClient.invalidateQueries({
        queryKey: repositoriesQuery.queryKey,
      })
      void queryClient.invalidateQueries({
        queryKey: openPullRequestCountsQuery.queryKey,
      })
      // Dropping a repo may shrink selected-or-in-use Active backends.
      void queryClient.invalidateQueries({
        queryKey: ["agentBackendStatus"],
      })
    },
  })

  const confirmRemoval = () => {
    if (
      window.confirm(`Remove ${repository.projectPath} and its stored issues?`)
    ) {
      removeRepository.mutate()
    }
  }

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(`[data-repo-menu="${repository.id}"]`)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [menuOpen, repository.id])

  const refreshIssues = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        refreshRepository: {
          __args: { repositoryId: repository.id },
          id: true,
          repositoryId: true,
        },
      })
      return result.refreshRepository
    },
    onMutate: () => {
      issuesChangeCountOnRefresh.current = issuesChangeCount
      setAwaitingRefresh(true)
    },
    onError: () => {
      setAwaitingRefresh(false)
    },
  })

  useEffect(() => {
    if (!awaitingRefresh) return
    if (issuesChangeCount !== issuesChangeCountOnRefresh.current) {
      setAwaitingRefresh(false)
    }
  }, [awaitingRefresh, issuesChangeCount])

  const refreshingIssues = refreshIssues.isPending || awaitingRefresh

  const addGitHubToken = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        addRepositoryGitHubToken: {
          __args: { repositoryId: repository.id },
          repositoryId: true,
          configured: true,
          githubTokenSecretName: true,
          githubTokenCreationUrl: true,
        },
      })
      return result.addRepositoryGitHubToken
    },
    onSuccess: (credential) => {
      queryClient.setQueryData<readonly Repository[]>(
        repositoriesQuery.queryKey,
        (repositories) =>
          repositories?.map((candidate) =>
            candidate.id === repository.id
              ? { ...candidate, credential }
              : candidate,
          ),
      )
    },
  })

  const addGitLabToken = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        addRepositoryGitLabToken: {
          __args: { repositoryId: repository.id },
          repositoryId: true,
          configured: true,
          githubTokenSecretName: true,
          githubTokenCreationUrl: true,
        },
      })
      return result.addRepositoryGitLabToken
    },
    onSuccess: (credential) => {
      queryClient.setQueryData<readonly Repository[]>(
        repositoriesQuery.queryKey,
        (repositories) =>
          repositories?.map((candidate) =>
            candidate.id === repository.id
              ? { ...candidate, credential }
              : candidate,
          ),
      )
    },
  })

  const updateRepositoryPaused = (updated: { id: string; paused: boolean }) => {
    queryClient.setQueryData<readonly Repository[]>(
      repositoriesQuery.queryKey,
      (repositories) =>
        repositories?.map((candidate) =>
          candidate.id === updated.id
            ? { ...candidate, paused: updated.paused }
            : candidate,
        ),
    )
  }

  const pauseRepository = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        pauseRepository: {
          __args: { repositoryId: repository.id },
          id: true,
          paused: true,
        },
      })
      return result.pauseRepository
    },
    onSuccess: updateRepositoryPaused,
  })

  const unpauseRepository = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        unpauseRepository: {
          __args: { repositoryId: repository.id },
          id: true,
          paused: true,
        },
      })
      return result.unpauseRepository
    },
    onSuccess: updateRepositoryPaused,
  })

  const pausePending = pauseRepository.isPending || unpauseRepository.isPending
  const pauseFailed = pauseRepository.isError || unpauseRepository.isError
  const pauseLabel = repository.paused
    ? "Unpause repository"
    : "Pause repository"
  const pauseButtonClass = repository.paused
    ? "border-oxblood/50 text-oxblood hover:bg-oxblood-wash focus-visible:outline-oxblood"
    : "border-sepia/50 text-sepia hover:bg-amber-wash focus-visible:outline-sepia"
  const repositoryLabel = `${repository.projectPath}`
  // Dedicated count projection: loading/last-known must not block the card.
  const {
    data: openPullRequestCounts,
    isPending: openPullRequestCountsPending,
    isFetching: openPullRequestCountsFetching,
  } = useQuery(openPullRequestCountsQuery)
  const {
    label: pullRequestCountLabel,
    display: pullRequestCountDisplay,
    loading: pullRequestCountLoading,
  } = openPullRequestCountPresentation({
    count: openPullRequestCounts?.[repository.id],
    isPending: openPullRequestCountsPending,
    isFetching: openPullRequestCountsFetching,
  })
  const {
    collapsed: repositoryCollapsed,
    toggleCollapsed: toggleRepositoryCollapsed,
  } = useCardCollapsed(repositoryCardCollapseId(repository.id))
  const repositoryBodyId = `repository-card-body-${repository.id}`

  return (
    <article className="relative min-w-0 border-t-2 border-ink-soft pt-7 first:border-t-0 first:pt-0 sm:pt-8">
      <div
        className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 ${repositoryCollapsed ? "" : "mb-5"}`}
      >
        <h2 className="m-0 flex min-w-0 max-w-full items-baseline gap-x-2 font-serif text-2xl font-semibold tracking-[-0.012em]">
          <a
            className="min-w-0 truncate text-ink hover:text-oxblood hover:underline"
            href={`https://${repository.forgeHost}/${repository.projectPath}`}
          >
            {repositoryLabel}
          </a>
          <span
            className="shrink-0 font-mono text-sm font-semibold tracking-normal text-ink-faint tabular-nums"
            title={pullRequestCountLabel}
            aria-busy={pullRequestCountLoading ? true : undefined}
          >
            <span className="sr-only">{pullRequestCountLabel}</span>
            <span aria-hidden="true">{pullRequestCountDisplay}</span>
          </span>
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          <CardCollapseToggle
            collapsed={repositoryCollapsed}
            onToggle={toggleRepositoryCollapsed}
            controlsId={repositoryBodyId}
            label={repositoryLabel}
          />
          <button
            type="button"
            className={`inline-flex size-8 items-center justify-center border transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-50 ${pauseFailed ? "border-oxblood text-oxblood hover:bg-oxblood-wash focus-visible:outline-oxblood" : pauseButtonClass}`}
            disabled={pausePending}
            onClick={() =>
              repository.paused
                ? unpauseRepository.mutate()
                : pauseRepository.mutate()
            }
            aria-label={pausePending ? `${pauseLabel} in progress` : pauseLabel}
            title={
              pauseFailed
                ? `Could not ${pauseLabel.toLowerCase()}. Try again.`
                : pauseLabel
            }
          >
            {pausePending ? (
              <svg
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="9"
                  stroke="currentColor"
                  strokeWidth="3"
                />
                <path
                  className="opacity-75"
                  d="M12 3a9 9 0 0 1 9 9"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
            ) : repository.paused ? (
              <svg
                aria-hidden="true"
                className="size-4"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="m8 5 11 7-11 7V5Z" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                className="size-4"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            )}
          </button>
          <span className="relative" data-repo-menu={repository.id}>
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center border border-rule-2 bg-panel text-ink-soft transition hover:border-ink-soft hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood"
              aria-label={`Actions for ${repository.projectPath}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg
                aria-hidden="true"
                className="size-4"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <circle cx="12" cy="5" r="1.75" />
                <circle cx="12" cy="12" r="1.75" />
                <circle cx="12" cy="19" r="1.75" />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute top-full right-0 z-10 mt-1 min-w-40 border border-rule-2 bg-panel py-1 shadow-[0_12px_30px_rgb(28_22_14_/_18%)]"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-2 text-left text-sm font-medium text-ink-2 hover:bg-paper-2"
                  onClick={() => {
                    setMenuOpen(false)
                    openSettings()
                  }}
                >
                  Settings
                </button>
                <hr className="my-1 border-t border-rule" />
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-2 text-left text-sm font-medium text-oxblood hover:bg-oxblood-wash disabled:cursor-wait disabled:opacity-50"
                  disabled={removeRepository.isPending}
                  onClick={() => {
                    setMenuOpen(false)
                    confirmRemoval()
                  }}
                >
                  {removeRepository.isPending ? "Removing..." : "Remove"}
                </button>
              </div>
            )}
          </span>
        </div>
      </div>
      <dialog
        ref={settingsDialogRef}
        className="m-auto w-[min(92vw,32rem)] border border-rule-2 bg-panel p-0 text-ink shadow-[0_18px_50px_rgb(28_22_14_/_18%)] backdrop:bg-black/50"
        aria-labelledby={`repo-settings-title-${repository.id}`}
        onCancel={(event) => {
          if (updateSettings.isPending) event.preventDefault()
        }}
        onClose={() => setSettingsOpen(false)}
      >
        <form onSubmit={saveSettings}>
          <div className="border-b border-rule px-6 py-5">
            <p className="font-mono text-xs font-semibold tracking-[0.22em] text-oxblood uppercase">
              Repository settings
            </p>
            <h2
              id={`repo-settings-title-${repository.id}`}
              className="mt-1.5 font-serif text-2xl font-semibold tracking-[-0.01em]"
            >
              {repository.projectPath}
            </h2>
            <p className="mt-1.5 text-sm text-ink-soft">
              Overrides apply on the next Agent Turn. Empty model fields use
              harness defaults for this Repository&apos;s effective Agent
              Backend.
            </p>
          </div>
          <div className="grid gap-5 px-6 py-5">
            <fieldset className="grid gap-3 border border-rule p-4">
              <legend className="px-1 font-mono text-xs font-semibold tracking-[0.16em] text-ink-faint uppercase">
                Forge identity
              </legend>
              <label className="grid gap-1.5 text-sm font-semibold text-ink-2">
                Forge
                <select
                  className="w-full border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15"
                  value={forge}
                  onChange={(event) =>
                    setForge(event.target.value as "github" | "gitlab")
                  }
                >
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-ink-2">
                Forge host
                <input
                  className="w-full border border-rule-2 bg-paper px-3 py-2 font-mono text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15"
                  required
                  value={forgeHost}
                  onChange={(event) => setForgeHost(event.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold text-ink-2">
                Project path
                <input
                  className="w-full border border-rule-2 bg-paper px-3 py-2 font-mono text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15"
                  required
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                />
              </label>
              <span className="text-xs text-ink-faint">
                GitLab identities are verified before Save. Identity changes are
                blocked after this Repository has any Work Item.
              </span>
            </fieldset>
            <label className="flex items-center gap-3 text-sm font-semibold text-ink-2">
              <input
                type="checkbox"
                className="size-4 accent-oxblood"
                checked={paused}
                onChange={(event) => setPaused(event.target.checked)}
              />
              Paused
              <span className="font-normal text-ink-faint">
                Skip autonomous work selection
              </span>
            </label>
            <label className="flex items-center gap-3 text-sm font-semibold text-ink-2">
              <input
                type="checkbox"
                className="size-4 accent-oxblood"
                checked={autoMerge}
                onChange={(event) => setAutoMerge(event.target.checked)}
              />
              Auto-merge
              <span className="font-normal text-ink-faint">
                Allow clanker merge when risk is low
              </span>
            </label>
            <label className="flex items-center gap-3 text-sm font-semibold text-ink-2">
              <input
                type="checkbox"
                className="size-4 accent-oxblood"
                checked={includeAllIssueAuthors}
                onChange={(event) =>
                  setIncludeAllIssueAuthors(event.target.checked)
                }
              />
              Include all Issue Authors
              <span className="font-normal text-ink-faint">
                Relevant Issues from every author after Refresh
              </span>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-ink-2">
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  className="size-4 accent-oxblood"
                  checked={waitForReadyForReviewChecks}
                  onChange={(event) =>
                    setWaitForReadyForReviewChecks(event.target.checked)
                  }
                />
                Wait for checks to start after ready for review
              </span>
              <span className="font-normal text-ink-faint">
                Wait up to 90 seconds for workflows that start after a PR is
                marked ready for review. If this repository has no such
                workflows, turn off this setting to skip the wait.
              </span>
            </label>

            <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
              Agent Backend
              <select
                className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15 disabled:cursor-not-allowed disabled:opacity-60"
                name="selectedAgentBackend"
                value={selectedAgentBackend ?? HARNESS_DEFAULT_BACKEND_VALUE}
                disabled={
                  backendChangeBlocked ||
                  updateSettings.isPending ||
                  agentBackends.isPending
                }
                onChange={(event) => {
                  applyAgentBackendSelection(event.target.value)
                }}
              >
                <option value={HARNESS_DEFAULT_BACKEND_VALUE}>
                  Harness default ({harnessDefaultBackendLabel})
                </option>
                {selectedAgentBackend !== null &&
                  !(agentBackends.data ?? []).some(
                    (backend) => backend.id === selectedAgentBackend,
                  ) && (
                    <option value={selectedAgentBackend}>
                      {selectedAgentBackend}
                    </option>
                  )}
                {(agentBackends.data ?? []).map((backend) => (
                  <option key={backend.id} value={backend.id}>
                    {backend.label}
                  </option>
                ))}
              </select>
              <span className="text-xs font-normal text-ink-faint">
                {backendChangeBlocked
                  ? `${repository.blockingUnfinishedWorkItemCount} unfinished Work Item${
                      repository.blockingUnfinishedWorkItemCount === 1
                        ? ""
                        : "s"
                    } on this Repository — finish or abandon them before changing Agent Backend.`
                  : "Harness default inherits the global selection. Override activates on Save when the effective backend changes. Model fields in this dialog are stashed per backend while open; empty means inherit harness for that effective backend."}
              </span>
            </label>

            {agentBackends.isError && (
              <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                Agent Backends list could not be loaded. You can still inherit
                the harness default; override options may be incomplete.
              </p>
            )}

            {usesPreviewCatalog && previewError !== null && (
              <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                Preview failed: {previewError}. Model fields stay disabled until
                preview succeeds.
                {backendDraftChanging
                  ? " Changing the effective backend cannot be saved until preview succeeds."
                  : " Non-model settings can still be saved."}
              </p>
            )}

            {modelsLoading ? (
              <p className="text-sm text-ink-soft">Loading models...</p>
            ) : !usesPreviewCatalog && models.isError ? (
              <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                Models could not be loaded.
              </p>
            ) : (
              <>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Build model
                  <select
                    className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 font-mono text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15 disabled:cursor-not-allowed disabled:opacity-60"
                    value={defaultModel}
                    disabled={modelsDisabled}
                    onChange={(event) => {
                      const nextModel = event.target.value
                      setDefaultModel(nextModel)
                      const sourceModel =
                        nextModel.length > 0 ? nextModel : harnessBuildForSource
                      const nextVariants = variantsForModel(
                        catalogModels,
                        sourceModel,
                      )
                      setDefaultVariant((current) =>
                        reconcileVariantForModel(current, nextVariants),
                      )
                      if (reviewModel.length === 0) {
                        const reviewSource =
                          nextModel.length > 0
                            ? nextModel
                            : harnessReviewForSource.length > 0
                              ? harnessReviewForSource
                              : harnessBuildForSource
                        setReviewVariant((current) =>
                          reconcileVariantForModel(
                            current,
                            variantsForModel(catalogModels, reviewSource),
                          ),
                        )
                      }
                    }}
                  >
                    <option value="">
                      Harness default ({harnessDefaultModel})
                    </option>
                    {hasUnavailableBuildModel && (
                      <option value={defaultModel}>
                        {defaultModel} (not in Agent Model catalog)
                      </option>
                    )}
                    {(catalogModels ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                </label>
                {buildVariantSourceModel.length > 0 &&
                buildVariantSourceUnavailable ? (
                  <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                    Build effort (thinking) override is unavailable — the
                    selected model is not in the Agent Model catalog. Use
                    harness default or pick another model.
                  </p>
                ) : buildVariantSourceModel.length > 0 &&
                  buildVariants.length === 0 ? (
                  <p className="bg-paper-2 p-3 text-sm text-ink-soft">
                    Build effort (thinking) override is unavailable — this model
                    has no effort (thinking) options. Use harness default or
                    pick another model.
                  </p>
                ) : (
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                    Build effort (thinking)
                    <select
                      className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15 disabled:cursor-not-allowed disabled:opacity-60"
                      value={defaultThinkingLevel}
                      onChange={(event) =>
                        setDefaultVariant(event.target.value)
                      }
                      disabled={
                        modelsDisabled ||
                        (buildVariantSourceModel.length > 0 &&
                          buildVariants.length === 0)
                      }
                    >
                      <option value="">
                        Harness default ({harnessDefaultVariant})
                      </option>
                      {hasCustomBuildVariant && (
                        <option value={defaultThinkingLevel}>
                          {formatVariantLabel(defaultThinkingLevel)}
                        </option>
                      )}
                      {buildVariants.map((variant) => (
                        <option key={variant} value={variant}>
                          {formatVariantLabel(variant)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Review model
                  <select
                    className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 font-mono text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15 disabled:cursor-not-allowed disabled:opacity-60"
                    value={reviewModel}
                    disabled={modelsDisabled}
                    onChange={(event) => {
                      const nextModel = event.target.value
                      setReviewModel(nextModel)
                      const sourceModel =
                        nextModel.length > 0
                          ? nextModel
                          : defaultModel.length > 0
                            ? defaultModel
                            : harnessReviewForSource.length > 0
                              ? harnessReviewForSource
                              : harnessBuildForSource
                      setReviewVariant((current) =>
                        reconcileVariantForModel(
                          current,
                          variantsForModel(catalogModels, sourceModel),
                        ),
                      )
                    }}
                  >
                    <option value="">
                      Harness default ({harnessReviewModel})
                    </option>
                    {hasUnavailableReviewModel && (
                      <option value={reviewModel}>
                        {reviewModel} (not in Agent Model catalog)
                      </option>
                    )}
                    {(catalogModels ?? []).map((model) => (
                      <option key={`review-${model.id}`} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                </label>
                {reviewThinkingLevelSourceModel.length > 0 &&
                reviewThinkingLevelSourceUnavailable ? (
                  <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                    Review effort (thinking) override is unavailable — the
                    selected model is not in the Agent Model catalog. Use
                    harness default or pick another model.
                  </p>
                ) : reviewThinkingLevelSourceModel.length > 0 &&
                  reviewThinkingLevels.length === 0 ? (
                  <p className="bg-paper-2 p-3 text-sm text-ink-soft">
                    Review effort (thinking) override is unavailable — this
                    model has no effort (thinking) options. Use harness default
                    or pick another model.
                  </p>
                ) : (
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                    Review effort (thinking)
                    <select
                      className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15 disabled:cursor-not-allowed disabled:opacity-60"
                      value={reviewThinkingLevel}
                      onChange={(event) => setReviewVariant(event.target.value)}
                      disabled={
                        modelsDisabled ||
                        (reviewThinkingLevelSourceModel.length > 0 &&
                          reviewThinkingLevels.length === 0)
                      }
                    >
                      <option value="">
                        Harness default ({harnessReviewVariant})
                      </option>
                      {hasCustomReviewVariant && (
                        <option value={reviewThinkingLevel}>
                          {formatVariantLabel(reviewThinkingLevel)}
                        </option>
                      )}
                      {reviewThinkingLevels.map((variant) => (
                        <option key={`review-${variant}`} value={variant}>
                          {formatVariantLabel(variant)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
            {updateSettings.isError && (
              <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                {updateSettings.error instanceof Error
                  ? updateSettings.error.message
                  : "Settings could not be saved. Try again."}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-3 border-t border-rule bg-paper-2 px-6 py-4">
            <button
              type="button"
              className="border border-rule-2 px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-paper"
              onClick={() => {
                settingsDialogRef.current?.close()
                setSettingsOpen(false)
              }}
              disabled={updateSettings.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="bg-oxblood px-4 py-2 text-sm font-semibold tracking-wide text-on-solid uppercase hover:bg-oxblood-deep disabled:cursor-wait disabled:opacity-60"
              disabled={
                updateSettings.isPending ||
                (backendChangeBlocked &&
                  selectedAgentBackend !== repository.selectedAgentBackend) ||
                (backendDraftChanging && modelsLoading) ||
                (backendDraftChanging &&
                  usesPreviewCatalog &&
                  !catalogReadyForModelValidation) ||
                (backendDraftChanging &&
                  usesPreviewCatalog &&
                  previewError !== null) ||
                blockSaveForUnavailableBuildModel
              }
            >
              {updateSettings.isPending ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </dialog>
      {!repositoryCollapsed && (
        <div id={repositoryBodyId}>
          <dl className="m-0 grid gap-x-8 gap-y-1.5 border-y border-rule py-3 sm:grid-cols-2">
            <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <dt className="shrink-0 font-mono font-semibold tracking-[0.12em] text-ink-faint uppercase">
                Path:
              </dt>
              <dd
                className="m-0 min-w-0 truncate font-mono text-ink-2"
                title={repository.localPath}
              >
                {repository.localPath}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <dt className="shrink-0 font-mono font-semibold tracking-[0.12em] text-ink-faint uppercase">
                Checkout:
              </dt>
              <dd className="m-0 min-w-0 truncate font-mono text-ink-2">
                {repository.isBare ? "Bare repository" : "Working tree"}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <dt className="shrink-0 font-mono font-semibold tracking-[0.12em] text-ink-faint uppercase">
                Agent Backend:
              </dt>
              <dd className="m-0 min-w-0 truncate font-mono text-ink-2">
                {repository.selectedAgentBackend === null
                  ? `Harness default (${repository.effectiveAgentBackend})`
                  : repository.effectiveAgentBackend}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <dt className="shrink-0 font-mono font-semibold tracking-[0.12em] text-ink-faint uppercase">
                Build model:
              </dt>
              <dd className="m-0 min-w-0 truncate font-mono text-ink-2">
                {repository.defaultModel ??
                  (repository.selectedAgentBackend === null
                    ? `Default (${
                        config.data?.defaultModel ?? "not configured"
                      })`
                    : "Harness default")}
                {" · "}
                {repository.defaultThinkingLevel ??
                  (repository.selectedAgentBackend === null
                    ? `Default (${
                        config.data?.defaultThinkingLevel ?? "not configured"
                      })`
                    : "Harness default")}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <dt className="shrink-0 font-mono font-semibold tracking-[0.12em] text-ink-faint uppercase">
                Review model:
              </dt>
              <dd className="m-0 min-w-0 truncate font-mono text-ink-2">
                {repository.reviewModel ??
                  (repository.selectedAgentBackend === null
                    ? `Default (${
                        config.data?.reviewModel ??
                        `Build (${
                          repository.defaultModel ??
                          config.data?.defaultModel ??
                          "not configured"
                        })`
                      })`
                    : "Harness default")}
                {" · "}
                {repository.reviewThinkingLevel ??
                  (repository.selectedAgentBackend === null
                    ? `Default (${
                        config.data?.reviewThinkingLevel ??
                        `Build (${
                          repository.defaultThinkingLevel ??
                          config.data?.defaultThinkingLevel ??
                          "not configured"
                        })`
                      })`
                    : "Harness default")}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <dt className="shrink-0 font-mono font-semibold tracking-[0.12em] text-ink-faint uppercase">
                Auto-merge:
              </dt>
              <dd className="m-0 font-mono text-ink-2">
                {repository.autoMerge ? "Enabled" : "Disabled"}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <dt className="shrink-0 font-mono font-semibold tracking-[0.12em] text-ink-faint uppercase">
                Include all Issue Authors:
              </dt>
              <dd className="m-0 font-mono text-ink-2">
                {repository.includeAllIssueAuthors ? "Enabled" : "Disabled"}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <dt className="shrink-0 font-mono font-semibold tracking-[0.12em] text-ink-faint uppercase">
                Wait for ready checks:
              </dt>
              <dd className="m-0 font-mono text-ink-2">
                {repository.waitForReadyForReviewChecks
                  ? "Enabled"
                  : "Disabled"}
              </dd>
            </div>
          </dl>
          {!repository.credential.configured &&
            repository.forge === "github" && (
              <Banner
                className="mt-5"
                tone="alarm"
                tag="Attention"
                role={addGitHubToken.isError ? "alert" : "status"}
                action={
                  githubTokenCreated ? (
                    <BannerActionButton
                      disabled={addGitHubToken.isPending}
                      onClick={() => addGitHubToken.mutate()}
                    >
                      {addGitHubToken.isPending
                        ? "Waiting for Keymaxxer"
                        : "Store in Keymaxxer"}
                    </BannerActionButton>
                  ) : (
                    <a
                      className="plate-mini"
                      href={repository.credential.githubTokenCreationUrl}
                      onClick={() => setGithubTokenCreated(true)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Create GitHub token
                    </a>
                  )
                }
              >
                <p className="m-0 font-semibold">GitHub token required</p>
                {githubTokenCreated ? (
                  <p className="m-0 mt-1">
                    Store the generated token as{" "}
                    <code className="font-bold">
                      {repository.credential.githubTokenSecretName}
                    </code>{" "}
                    in Keymaxxer. Already-created tokens are not upgraded
                    automatically — edit the token on GitHub or recreate it,
                    then store the replacement.
                  </p>
                ) : (
                  <p className="m-0 mt-1">
                    Create a fine-grained token, choose{" "}
                    <strong>Only select repositories</strong>, select{" "}
                    <code className="font-bold">
                      {repository.projectPath.split("/").at(-1)}
                    </code>
                    , and allow <strong>Actions: Read and write</strong>{" "}
                    (required for workflow reruns and CI logs). Already-created
                    tokens are not upgraded automatically — edit or recreate
                    them if Actions is still read-only.
                  </p>
                )}
                {addGitHubToken.isError ? (
                  <p className="m-0 mt-1">
                    Keymaxxer setup was cancelled or failed.
                  </p>
                ) : null}
              </Banner>
            )}
          {!repository.credential.configured &&
            repository.forge === "gitlab" && (
              <Banner
                className="mt-5"
                tone="alarm"
                tag="Attention"
                role={addGitLabToken.isError ? "alert" : "status"}
                action={
                  gitlabTokenCreated ? (
                    <BannerActionButton
                      disabled={addGitLabToken.isPending}
                      onClick={() => addGitLabToken.mutate()}
                    >
                      {addGitLabToken.isPending
                        ? "Waiting for Keymaxxer"
                        : "Store in Keymaxxer"}
                    </BannerActionButton>
                  ) : (
                    <a
                      className="plate-mini"
                      href={repository.credential.githubTokenCreationUrl}
                      onClick={() => setGitlabTokenCreated(true)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Create GitLab token
                    </a>
                  )
                }
              >
                <p className="m-0 font-semibold">
                  GitLab authentication required
                </p>
                <p className="m-0 mt-1">
                  {gitlabTokenCreated ? (
                    <>
                      Store the generated token as{" "}
                      <code className="font-bold">
                        {repository.credential.githubTokenSecretName}
                      </code>{" "}
                      in Keymaxxer when available (provider{" "}
                      <code className="font-bold">gitlab</code>, account{" "}
                      <code className="font-bold">
                        {repository.forgeHost}/{repository.projectPath}
                      </code>
                      ). Or set ambient auth without Keymaxxer:{" "}
                    </>
                  ) : (
                    <>
                      Create a personal access token on this GitLab instance
                      with API access for{" "}
                      <code className="font-bold">
                        {repository.projectPath}
                      </code>
                      . Store it in Keymaxxer when available, or set ambient
                      auth:{" "}
                    </>
                  )}
                  <code className="font-bold">GITLAB_TOKEN</code> or{" "}
                  <code className="font-bold">
                    glab auth login --hostname {repository.forgeHost}
                  </code>{" "}
                  before starting the Harness.
                </p>
                {addGitLabToken.isError ? (
                  <p className="m-0 mt-1">
                    Keymaxxer setup was cancelled or failed. Use ambient{" "}
                    <code className="font-bold">GITLAB_TOKEN</code> or{" "}
                    <code className="font-bold">glab auth login</code> and
                    restart the Harness if Keymaxxer is unavailable.
                  </p>
                ) : null}
              </Banner>
            )}
          <div className="mt-5">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h3 className="m-0 font-mono text-xs font-semibold tracking-[0.22em] text-oxblood uppercase">
                Relevant issues
              </h3>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center border border-rule-2 bg-panel text-ink-soft transition hover:border-ink-soft hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood disabled:cursor-wait disabled:opacity-60"
                disabled={refreshingIssues || !repository.credential.configured}
                onClick={() => refreshIssues.mutate()}
                aria-label={
                  refreshingIssues ? "Refreshing issues" : "Refresh issues"
                }
                title={
                  repository.credential.configured
                    ? "Refresh issues"
                    : repository.forge === "gitlab"
                      ? "Authenticate GitLab before refreshing issues"
                      : "Add a GitHub token before refreshing issues"
                }
              >
                <svg
                  aria-hidden="true"
                  className={`size-4 ${refreshingIssues ? "animate-spin motion-reduce:animate-none" : ""}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" />
                  <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
                </svg>
              </button>
            </div>
            {refreshIssues.isError && (
              <p className="mb-2 text-sm text-oxblood-deep" role="alert">
                Failed to refresh issues.
              </p>
            )}
            {repository.issuesReconciledAt === null ? (
              <p className="m-0 font-serif text-sm italic text-ink-soft">
                Not refreshed yet.
              </p>
            ) : (
              <Suspense fallback={<RepositoryIssuesSkeleton />}>
                <RepositoryIssues
                  repository={repository}
                  workItems={workItems}
                  workItemsLoading={workItemsLoading}
                />
              </Suspense>
            )}
          </div>
          {removeRepository.isError && (
            <p className="mt-3 mb-0 text-sm text-oxblood-deep" role="alert">
              Could not remove repository. Please try again.
            </p>
          )}
        </div>
      )}
    </article>
  )
}

function RepositoryIssues({
  repository,
  workItems,
  workItemsLoading,
}: {
  repository: Repository
  workItems: readonly WorkItem[]
  workItemsLoading: boolean
}) {
  const { data: issues } = useSuspenseQuery(issuesQuery(repository.id))

  if (issues.length === 0) {
    return (
      <p className="m-0 font-serif text-sm italic text-ink-soft">
        No issues found this harness can work on.
      </p>
    )
  }

  const childrenByParent = new Map<number, RepositoryIssue[]>()
  for (const issue of issues) {
    if (issue.parent === null) continue
    const children = childrenByParent.get(issue.parent.issueNumber) ?? []
    children.push(issue)
    childrenByParent.set(issue.parent.issueNumber, children)
  }

  return (
    <ul className="m-0 grid list-none gap-1 p-0">
      {issues.map((issue) => {
        if (issue.parent !== null) return null
        if (!issue.hasChildren) {
          return (
            <RepositoryIssueRow
              issue={issue}
              key={issue.id}
              repository={repository}
              workItems={workItems}
              workItemsLoading={workItemsLoading}
            />
          )
        }

        const children = childrenByParent.get(issue.issueNumber) ?? []
        const closedChildren = children.filter(
          (child) => child.state === "CLOSED",
        ).length
        return (
          <ParentIssueGroup
            key={issue.id}
            parent={issue}
            childIssues={children}
            closedChildren={closedChildren}
            repository={repository}
            workItems={workItems}
            workItemsLoading={workItemsLoading}
          />
        )
      })}
    </ul>
  )
}

function ParentIssueGroup({
  parent,
  childIssues,
  closedChildren,
  repository,
  workItems,
  workItemsLoading,
}: {
  parent: RepositoryIssue
  childIssues: readonly RepositoryIssue[]
  closedChildren: number
  repository: Repository
  workItems: readonly WorkItem[]
  workItemsLoading: boolean
}) {
  const queryClient = useQueryClient()
  const openChildren = childIssues.filter((child) => child.state === "OPEN")
  const canImplementAll = isParentImplementAllWithAutoMergeEligible({
    openChildren,
    directChildren: childIssues,
    workItemsLoading,
  })
  const implementAll = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        implementAllWithAutoMerge: {
          __args: {
            repositoryId: parent.repositoryId,
            issueNumber: parent.issueNumber,
          },
          ...workItemFields,
        },
      })
      return result.implementAllWithAutoMerge
    },
    // Covered rows may be newly created or adopted (same id, updated mergeMode).
    // Update matching ids in every work-items cache; only append missing ids
    // into the default Issues list and Jobs WORKING (never Failed/Completed).
    onSuccess: (covered) => {
      const byId = new Map(covered.map((item) => [item.id, item]))
      for (const [queryKey] of queryClient.getQueriesData<readonly WorkItem[]>({
        queryKey: ["work-items", parent.repositoryId],
      })) {
        // queryKey: ["work-items", repositoryId, listKind | null, limit | null]
        const listKind = queryKey[2]
        const allowAppend = listKind === null || listKind === "WORKING"
        queryClient.setQueryData<readonly WorkItem[]>(queryKey, (current) => {
          const next: WorkItem[] = []
          const seen = new Set<string>()
          for (const item of current ?? []) {
            const updated = byId.get(item.id)
            if (updated !== undefined) {
              next.push(updated)
              seen.add(item.id)
            } else {
              next.push(item)
            }
          }
          if (allowAppend) {
            for (const item of covered) {
              if (!seen.has(item.id)) {
                next.push(item)
              }
            }
          }
          return next
        })
      }
    },
  })

  return (
    <li className="min-w-0">
      <details
        className="group -mx-2 border border-rule-2 bg-panel px-2 py-1"
        open
      >
        <summary className="grid cursor-pointer list-none grid-cols-[2.25rem_minmax(0,1fr)_auto] items-start gap-2 py-1.5 marker:content-none">
          <span className="font-mono text-xs leading-5 font-semibold text-oxblood">
            #{parent.issueNumber}
          </span>
          <span className="min-w-0">
            <a
              className="font-serif text-[0.95rem] font-semibold text-ink hover:text-oxblood hover:underline"
              href={parent.url}
              onClick={(event) => event.stopPropagation()}
            >
              {parent.title}
            </a>
            {parent.issueAuthor !== null && parent.issueAuthor !== "" && (
              <span className="mt-0.5 block font-mono text-xs text-ink-faint">
                {parent.issueAuthor}
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="font-mono text-xs font-semibold tracking-[0.1em] text-ink-faint uppercase">
              {closedChildren}/{childIssues.length} closed
            </span>
            <svg
              aria-hidden="true"
              className="size-3.5 text-ink-faint transition-transform group-open:rotate-180"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
            {canImplementAll && (
              <ParentIssueActionsMenu
                parentIssueNumber={parent.issueNumber}
                menuId={parent.id}
                pending={implementAll.isPending}
                errorMessage={
                  implementAll.isError
                    ? "Could not start Implement all with auto-merge. Refresh the issues and try again."
                    : null
                }
                onImplementAllWithAutoMerge={() => implementAll.mutate()}
              />
            )}
          </span>
        </summary>
        <ul className="relative m-0 grid list-none gap-1 py-1 pl-0 before:absolute before:top-0 before:bottom-1 before:-left-2 before:w-px before:bg-rule-2">
          {childIssues.map((child) => (
            <RepositoryIssueRow
              issue={child}
              key={child.id}
              repository={repository}
              workItems={workItems}
              workItemsLoading={workItemsLoading}
            />
          ))}
        </ul>
      </details>
    </li>
  )
}

function RepositoryIssueRow({
  issue,
  repository,
  workItems,
  workItemsLoading,
}: {
  issue: RepositoryIssue
  repository: Repository
  workItems: readonly WorkItem[]
  workItemsLoading: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const queryClient = useQueryClient()
  const query = workItemsQuery(issue.repositoryId)
  const issueWorkItems = workItems.filter(
    (workItem) => workItem.issueNumber === issue.issueNumber,
  )
  const latestWorkItem = issueWorkItems.at(-1)
  const { canImplement, canQueue } = issueActionEligibility({
    issue,
    workItems: issueWorkItems,
    workItemsLoading,
  })
  const onImplementSuccess = (workItem: WorkItem) => {
    queryClient.setQueryData<readonly WorkItem[]>(query.queryKey, (current) => [
      ...(current ?? []),
      workItem,
    ])
  }
  const implementNow = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        implementNow: {
          __args: {
            repositoryId: issue.repositoryId,
            issueNumber: issue.issueNumber,
          },
          ...workItemFields,
        },
      })
      return result.implementNow
    },
    onSuccess: onImplementSuccess,
  })
  const implementLocally = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        implementLocally: {
          __args: {
            repositoryId: issue.repositoryId,
            issueNumber: issue.issueNumber,
          },
          ...workItemFields,
        },
      })
      return result.implementLocally
    },
    onSuccess: onImplementSuccess,
  })
  const queueIssue = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        queue: {
          __args: {
            repositoryId: issue.repositoryId,
            issueNumber: issue.issueNumber,
          },
          ...workItemFields,
        },
      })
      return result.queue
    },
    onSuccess: onImplementSuccess,
  })
  const implementPending =
    implementNow.isPending || implementLocally.isPending || queueIssue.isPending

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(`[data-issue-menu="${issue.id}"]`)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [issue.id, menuOpen])

  return (
    <li
      className={`min-w-0 text-sm ${issue.blockedBy.length > 0 ? "-mx-2 border border-sepia/40 bg-amber-wash px-2 py-2" : "entry-rule py-2"}`}
    >
      <div className="grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)_auto] items-start gap-2">
        <span className="font-mono text-xs leading-5 font-semibold text-oxblood">
          #{issue.issueNumber}
        </span>
        <span className="min-w-0">
          <a
            className="font-serif text-[0.95rem] font-semibold break-words text-ink hover:text-oxblood hover:underline"
            href={issue.url}
          >
            {issue.title}
          </a>
          {issue.issueAuthor !== null && issue.issueAuthor !== "" && (
            <span className="mt-0.5 block font-mono text-xs text-ink-faint">
              {issue.issueAuthor}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {issue.state === "CLOSED" && (
            <span className="stamp border-rule-2 text-ink-faint">Closed</span>
          )}
          {issue.blockedBy.length > 0 && (
            <span className="stamp border-sepia/50 bg-amber-wash text-sepia">
              Blocked
            </span>
          )}
          {(canImplement || canQueue) && (
            <span className="relative" data-issue-menu={issue.id}>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center border border-rule-2 bg-panel text-ink-soft hover:border-ink-soft hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood"
                aria-label={`Actions for issue #${issue.issueNumber}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <svg
                  aria-hidden="true"
                  className="size-4"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <circle cx="12" cy="5" r="1.75" />
                  <circle cx="12" cy="12" r="1.75" />
                  <circle cx="12" cy="19" r="1.75" />
                </svg>
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute top-full right-0 z-10 mt-1 min-w-44 border border-rule-2 bg-panel py-1 shadow-[0_12px_30px_rgb(28_22_14_/_18%)]"
                >
                  {canImplement && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className="block w-full px-3 py-2 text-left text-sm font-medium text-ink-2 hover:bg-paper-2"
                        disabled={implementPending}
                        onClick={() => {
                          setMenuOpen(false)
                          implementLocally.reset()
                          queueIssue.reset()
                          implementNow.mutate()
                        }}
                      >
                        {implementNow.isPending
                          ? "Starting..."
                          : "Implement now"}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="block w-full px-3 py-2 text-left text-sm font-medium text-ink-2 hover:bg-paper-2"
                        disabled={implementPending}
                        onClick={() => {
                          setMenuOpen(false)
                          implementNow.reset()
                          queueIssue.reset()
                          implementLocally.mutate()
                        }}
                      >
                        {implementLocally.isPending
                          ? "Starting..."
                          : "Implement locally"}
                      </button>
                    </>
                  )}
                  {canQueue && (
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full px-3 py-2 text-left text-sm font-medium text-ink-2 hover:bg-paper-2"
                      disabled={implementPending}
                      onClick={() => {
                        setMenuOpen(false)
                        implementNow.reset()
                        implementLocally.reset()
                        queueIssue.mutate()
                      }}
                    >
                      {queueIssue.isPending ? "Queueing..." : "Queue"}
                    </button>
                  )}
                </div>
              )}
            </span>
          )}
        </span>
      </div>
      {latestWorkItem !== undefined && (
        <WorkItemLifecycleStatus
          workItem={latestWorkItem}
          issueUrl={
            issue.url !== ""
              ? issue.url
              : workItemIssueUrl(
                  repository.forge,
                  repository.forgeHost,
                  repository.projectPath,
                  latestWorkItem.issueNumber,
                )
          }
          pullRequestUrl={workItemPullRequestUrl(
            repository.forge,
            repository.forgeHost,
            repository.projectPath,
            latestWorkItem.pullRequestNumber,
          )}
        />
      )}
      {(implementNow.isError ||
        implementLocally.isError ||
        queueIssue.isError) && (
        <p className="mt-1.5 mb-0 pl-11 text-xs text-oxblood-deep" role="alert">
          {queueIssue.isError
            ? "Could not queue issue. Refresh the issues and try again."
            : "Could not start implementation. Refresh the issues and try again."}
        </p>
      )}
      {issue.blockedBy.length > 0 && (
        <p className="mt-1.5 mb-0 pl-11 font-mono text-xs text-sepia">
          Blocked by{" "}
          {issue.blockedBy.map((blocker, index) => (
            <span key={blocker.issueUrl}>
              {index > 0 && ", "}
              <a
                className="font-semibold underline decoration-rule-2 underline-offset-2 hover:text-oxblood"
                href={blocker.issueUrl}
              >
                #{blocker.issueNumber}
              </a>
            </span>
          ))}
        </p>
      )}
    </li>
  )
}

export function SessionUsageDialog({
  workItemId,
  sessionId,
  open,
  onClose,
}: {
  workItemId: string | null
  sessionId: string | null
  open: boolean
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const enabled = open && workItemId !== null
  const session = useQuery({
    ...sessionQuery(workItemId ?? ""),
    enabled,
  })

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (open) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [open])

  const backendLabel = session.data?.backend.label

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-[min(92vw,28rem)] border border-rule-2 bg-panel p-0 text-ink shadow-[0_18px_50px_rgb(28_22_14_/_18%)] backdrop:bg-black/50"
      aria-labelledby="session-usage-title"
      onClose={onClose}
    >
      <div className="border-b border-rule px-5 py-4">
        <p className="font-mono text-xs font-semibold tracking-[0.22em] text-oxblood uppercase">
          Session usage
        </p>
        <h2
          id="session-usage-title"
          className="mt-1.5 font-serif text-lg font-semibold"
        >
          {backendLabel ? `${backendLabel} Session` : "Session"}
        </h2>
        {sessionId !== null && (
          <p
            className="mt-1 truncate font-mono text-xs text-ink-faint"
            title={sessionId}
          >
            {sessionId}
          </p>
        )}
      </div>
      <div className="px-5 py-4">
        {!enabled ? null : session.isPending ? (
          <p className="m-0 text-sm text-ink-soft">Loading usage…</p>
        ) : session.isError ? (
          <p
            className="m-0 border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep"
            role="alert"
          >
            Could not load Session usage. Close and try again.
          </p>
        ) : session.data === null || session.data === undefined ? (
          <p
            className="m-0 border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep"
            role="status"
          >
            Work Item not found.
          </p>
        ) : session.data.availability === "UNSUPPORTED" ? (
          <p
            className="m-0 border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep"
            role="status"
          >
            {session.data.backend.label} does not provide Session Telemetry.
          </p>
        ) : session.data.availability === "MISSING" ? (
          <p
            className="m-0 border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep"
            role="status"
          >
            {session.data.backend.label} no longer has this Session locally.
            Usage cannot be loaded.
          </p>
        ) : session.data.availability === "UNAVAILABLE" ? (
          <div className="grid gap-3">
            <p
              className="m-0 border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep"
              role="status"
            >
              {session.data.backend.label} Session Telemetry is temporarily
              unavailable. Retry in a moment.
            </p>
            <button
              type="button"
              className="justify-self-start border border-rule-2 bg-paper px-3 py-1.5 text-sm font-semibold text-ink-2 transition hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood"
              onClick={() => {
                void session.refetch()
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <table className="w-full border-collapse text-left text-sm">
            <tbody>
              <tr className="border-b border-rule-soft">
                <th
                  className="py-1.5 pr-3 font-semibold text-ink-soft"
                  scope="row"
                >
                  Model
                </th>
                <td className="py-1.5 font-mono text-ink-2">
                  {session.data.model === null ||
                  session.data.model === undefined
                    ? "—"
                    : [
                        session.data.model.providerId,
                        session.data.model.id,
                        session.data.model.thinkingLevel,
                      ]
                        .filter(
                          (part) =>
                            part !== null && part !== undefined && part !== "",
                        )
                        .join(" / ")}
                </td>
              </tr>
              <tr className="border-b border-rule-soft">
                <th
                  className="py-1.5 pr-3 font-semibold text-ink-soft"
                  scope="row"
                >
                  Input tokens
                </th>
                <td className="py-1.5 tabular-nums text-ink-2">
                  {formatTokenCount(session.data.tokens?.input ?? 0)}
                </td>
              </tr>
              <tr className="border-b border-rule-soft">
                <th
                  className="py-1.5 pr-3 font-semibold text-ink-soft"
                  scope="row"
                >
                  Output tokens
                </th>
                <td className="py-1.5 tabular-nums text-ink-2">
                  {formatTokenCount(session.data.tokens?.output ?? 0)}
                </td>
              </tr>
              <tr className="border-b border-rule-soft">
                <th
                  className="py-1.5 pr-3 font-semibold text-ink-soft"
                  scope="row"
                >
                  Reasoning tokens
                </th>
                <td className="py-1.5 tabular-nums text-ink-2">
                  {formatTokenCount(session.data.tokens?.reasoning ?? 0)}
                </td>
              </tr>
              <tr className="border-b border-rule-soft">
                <th
                  className="py-1.5 pr-3 font-semibold text-ink-soft"
                  scope="row"
                >
                  Cache read
                </th>
                <td className="py-1.5 tabular-nums text-ink-2">
                  {formatTokenCount(session.data.tokens?.cacheRead ?? 0)}
                </td>
              </tr>
              <tr className="border-b border-rule-soft">
                <th
                  className="py-1.5 pr-3 font-semibold text-ink-soft"
                  scope="row"
                >
                  Cache write
                </th>
                <td className="py-1.5 tabular-nums text-ink-2">
                  {formatTokenCount(session.data.tokens?.cacheWrite ?? 0)}
                </td>
              </tr>
              <tr className="border-b border-rule-soft">
                <th
                  className="py-1.5 pr-3 font-semibold text-ink-soft"
                  scope="row"
                >
                  Cost
                </th>
                <td className="py-1.5 tabular-nums text-ink-2">
                  {session.data.cost === null || session.data.cost === undefined
                    ? "—"
                    : formatSessionCost(session.data.cost)}
                </td>
              </tr>
              <tr className="border-b border-rule-soft">
                <th
                  className="py-1.5 pr-3 font-semibold text-ink-soft"
                  scope="row"
                >
                  Created
                </th>
                <td className="py-1.5 text-ink-2">
                  {formatSessionInstant(session.data.createdAt)}
                </td>
              </tr>
              <tr>
                <th
                  className="py-1.5 pr-3 font-semibold text-ink-soft"
                  scope="row"
                >
                  Updated
                </th>
                <td className="py-1.5 text-ink-2">
                  {formatSessionInstant(session.data.updatedAt)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      <div className="flex justify-end border-t border-rule px-5 py-3">
        <button
          type="button"
          className="border border-rule-2 bg-paper px-3 py-1.5 text-sm font-semibold text-ink-2 transition hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood"
          onClick={() => {
            dialogRef.current?.close()
          }}
        >
          Close
        </button>
      </div>
    </dialog>
  )
}

export function JobsCardSkeleton() {
  return (
    <article
      className="border border-rule-2 bg-panel px-4 py-3 sm:px-5"
      role="status"
      aria-label="Loading jobs"
      aria-busy="true"
    >
      <div className="grid gap-2">
        <span className="block h-12 animate-pulse bg-paper-2 motion-reduce:animate-none" />
        <span className="block h-12 animate-pulse bg-paper-2 motion-reduce:animate-none" />
      </div>
    </article>
  )
}

export function WorkItemPauseButton({ workItem }: { workItem: WorkItem }) {
  const queryClient = useQueryClient()
  const updateWorkItem = (updated: WorkItem) => {
    patchWorkItemsCaches(queryClient, workItem.repositoryId, (current) =>
      current?.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      ),
    )
  }
  const pause = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        pauseWorkItem: {
          __args: { workItemId: workItem.id },
          ...workItemFields,
        },
      })
      return result.pauseWorkItem
    },
    onSuccess: updateWorkItem,
  })
  const start = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        startWorkItem: {
          __args: { workItemId: workItem.id },
          ...workItemFields,
        },
      })
      return result.startWorkItem
    },
    onSuccess: updateWorkItem,
  })

  if (workItem.isTerminal || workItem.status === "WAITING_FOR_BLOCKERS") {
    return null
  }

  const pending = pause.isPending || start.isPending
  const failed = pause.isError || start.isError
  const label = workItem.paused ? "Start job" : "Pause job"

  const pauseClass = failed
    ? "icon-btn icon-btn--armed"
    : workItem.paused
      ? "icon-btn icon-btn--paused"
      : "icon-btn"

  return (
    <button
      type="button"
      className={pauseClass}
      disabled={pending}
      onClick={() => (workItem.paused ? start.mutate() : pause.mutate())}
      aria-label={pending ? `${label} in progress` : label}
      title={failed ? `Could not ${label.toLowerCase()}. Try again.` : label}
    >
      {pending ? (
        <svg
          aria-hidden="true"
          className="animate-spin motion-reduce:animate-none"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            strokeWidth="3"
          />
          <path
            className="opacity-75"
            d="M12 3a9 9 0 0 1 9 9"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      ) : workItem.paused ? (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
          <path d="m8 5 11 7-11 7V5Z" />
        </svg>
      ) : (
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      )}
    </button>
  )
}

export function WorkItemLifecycleStatus({
  workItem,
  compact = false,
  /**
   * Kanban-only: collapse earlier Build/Review/PR lane chips into summary
   * rows. Other surfaces leave this off for the full list.
   */
  collapseEarlierLanes = false,
  pullRequestUrl = null,
  issueUrl = null,
}: {
  workItem: WorkItem
  compact?: boolean
  collapseEarlierLanes?: boolean
  pullRequestUrl?: string | null
  issueUrl?: string | null
}) {
  const queryClient = useQueryClient()
  const status = workItem.status
  const heldForBlockers = status === "WAITING_FOR_BLOCKERS"
  // Queue hold: Retry is never offered; API also sets canRetry false.
  const canRetry = compact && workItem.canRetry && !heldForBlockers
  const retriesStatusChecks =
    workItem.failureCode === "pr_status_checks_unresolved" ||
    workItem.state === "WATCH_PR_STATUS_CHECKS" ||
    workItem.state === "INVESTIGATE_PR_STATUS_CHECKS" ||
    (workItem.canRetry &&
      workItem.lifecycleLabels.at(-1)?.phase === "GITHUB_STATUS_CHECKS")
  // Reset cancels/deletes a Work Item (history + worktree). Compact non-terminal
  // cards (held Queue and other unfinished work) keep it; Completed/Failed
  // terminal history never does. Needs Human stays on Working and keeps cancel.
  const canReset = canShowWorkItemResetAction({
    compact,
    isTerminal: workItem.isTerminal,
    isNeedsHuman: status === "NEEDS_HUMAN",
  })
  const dataUpdatedAt = queryClient
    .getQueriesData({ queryKey: ["work-items", workItem.repositoryId] })
    .reduce(
      (latest, [queryKey]) =>
        Math.max(
          latest,
          queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0,
        ),
      0,
    )
  const nowMs = useNowMs(true)
  const [expandedEarlierLanes, setExpandedEarlierLanes] = useState(
    () => new Set<LifecyclePipelineLaneId>(),
  )
  const patchWorkItem = (updated: WorkItem) => {
    patchWorkItemsCaches(queryClient, workItem.repositoryId, (current) =>
      current?.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      ),
    )
  }
  const retry = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        retryWorkItem: {
          __args: { workItemId: workItem.id },
          ...workItemFields,
        },
      })
      return result.retryWorkItem
    },
    onSuccess: patchWorkItem,
  })
  const reset = useMutation({
    mutationFn: async () => {
      const result = await graphql.mutation({
        resetWorkItem: {
          __args: { workItemId: workItem.id },
        },
      })
      return result.resetWorkItem
    },
    onSuccess: (deletedId) => {
      patchWorkItemsCaches(queryClient, workItem.repositoryId, (current) =>
        current?.filter((candidate) => candidate.id !== deletedId),
      )
    },
  })
  const actionsPending = retry.isPending || reset.isPending
  const prNumber = workItem.pullRequestNumber
  const statusBadgeClassName = statusBadgeClassNameForStatus(status)
  const statusMessageClassName = statusMessageClassNameForStatus(status)
  const openPullRequestLabel =
    prNumber === null ? null : `Open pull request #${prNumber}`
  const isNoChangeComplete =
    workItem.state === "COMPLETE" &&
    prNumber === null &&
    workItem.completionSummary !== null &&
    workItem.completionSummary.trim() !== ""
  const focusLane = collapseEarlierLanes
    ? lifecycleFocusLaneFor(workItem)
    : null
  const chipBlocks = planLifecycleChipPresentation(workItem.lifecycleLabels, {
    collapseEarlierLanes,
    focusLane,
    expandedEarlierLanes,
  })
  const toggleEarlierLane = (lane: LifecyclePipelineLaneId) => {
    setExpandedEarlierLanes((current) => {
      const next = new Set(current)
      if (next.has(lane)) {
        next.delete(lane)
      } else {
        next.add(lane)
      }
      return next
    })
  }
  const renderLifecycleChip = (lifecycleLabel: LifecycleLabelChip) => {
    const displayDurationMs = liveDurationMs(
      lifecycleLabel.durationMs,
      isLiveDurationStatus(lifecycleLabel.status),
      dataUpdatedAt,
      nowMs,
    )
    const linkToPullRequest =
      !isNoChangeComplete &&
      pullRequestUrl !== null &&
      openPullRequestLabel !== null &&
      lifecycleLabel.phase === "DECIDE_PR_MERGE" &&
      lifecycleLabel.status === "NEEDS_HUMAN"
    const chipClassName = lifecycleStepChipClassNameForStatus(
      lifecycleLabel.status,
    )
    // Only RUNNING chips take current-lane fill; needs-human/fail use Attention.
    const chipLane =
      lifecycleLabel.status === "RUNNING"
        ? lifecycleLaneForPhase(lifecycleLabel.phase)
        : null
    const chipStyle =
      chipLane !== null
        ? (lifecycleLaneCssVars(chipLane) as CSSProperties)
        : undefined
    const duration = displayDurationMs !== null && (
      <span className="ml-1 opacity-90">
        · {formatDuration(displayDurationMs)}
      </span>
    )
    return (
      <li key={lifecycleLabel.phase}>
        {linkToPullRequest ? (
          <a
            className={`${chipClassName} hover:underline`}
            href={pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${openPullRequestLabel}: ${lifecycleLabel.label}`}
            style={chipStyle}
          >
            {lifecycleLabel.label}
            {duration}
          </a>
        ) : (
          <span className={chipClassName} style={chipStyle}>
            {lifecycleLabel.label}
            {duration}
          </span>
        )}
      </li>
    )
  }
  const renderChipList = (
    chips: readonly LifecycleLabelChip[],
    options?: {
      readonly id?: string
      readonly className?: string
      readonly ariaLabel?: string
    },
  ) => (
    <ol
      id={options?.id}
      className={
        options?.className ?? "mt-2 mb-0 flex list-none flex-wrap gap-1 p-0"
      }
      aria-label={options?.ariaLabel ?? "Lifecycle steps"}
    >
      {chips.map(renderLifecycleChip)}
    </ol>
  )

  return (
    <div className={compact ? "mt-2" : "field-rule mt-2 ml-11 px-3 py-2"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="job-ticket-runtime-line uppercase tracking-[0.1em]">
          {formatStartedAgo(workItem.createdAt, nowMs)}
        </span>
        <WorkItemOutcomePresentation
          state={workItem.state}
          statusLabel={workItem.statusLabel}
          statusBadgeClassName={statusBadgeClassName}
          pullRequestNumber={workItem.pullRequestNumber}
          pullRequestUrl={pullRequestUrl}
          completionSummary={workItem.completionSummary}
          issueUrl={issueUrl}
        />
      </div>
      {workItem.lifecycleLabels.length > 0 &&
        (chipBlocks.length === 1 && chipBlocks[0]?.kind === "full-list" ? (
          renderChipList(chipBlocks[0].chips)
        ) : (
          <div className="mt-2 flex flex-col gap-1">
            {chipBlocks.map((block) => {
              if (block.kind === "earlier-lane") {
                const chipsId = `lifecycle-lane-${workItem.id}-${block.lane}`
                const durationLabel =
                  block.durationMs === null
                    ? null
                    : formatDuration(block.durationMs)
                const summaryStyle = lifecycleLaneCssVars(
                  block.lane,
                ) as CSSProperties
                return (
                  <div key={block.lane} className="min-w-0">
                    <button
                      type="button"
                      className="leg-summary"
                      style={summaryStyle}
                      aria-expanded={block.expanded}
                      aria-controls={block.expanded ? chipsId : undefined}
                      onClick={() => toggleEarlierLane(block.lane)}
                    >
                      <span aria-hidden="true">
                        {block.expanded ? "▾" : "▸"}
                      </span>
                      <span>{block.laneLabel}</span>
                      {durationLabel !== null && <span>· {durationLabel}</span>}
                    </button>
                    {block.expanded &&
                      renderChipList(block.chips, {
                        id: chipsId,
                        className:
                          "mt-1 mb-0 flex list-none flex-wrap gap-1 p-0",
                        ariaLabel: `${block.laneLabel} lifecycle steps`,
                      })}
                  </div>
                )
              }
              if (block.kind === "focus-lane") {
                if (block.chips.length === 0) return null
                return (
                  <div key="focus-lane">
                    {renderChipList(block.chips, {
                      className: "m-0 flex list-none flex-wrap gap-1 p-0",
                      ariaLabel: "Current lifecycle steps",
                    })}
                  </div>
                )
              }
              return <div key="full-list">{renderChipList(block.chips)}</div>
            })}
          </div>
        ))}
      {workItem.statusMessage !== null && (
        <p className={statusMessageClassName}>
          {statusMessageClassName.includes("status-message--alarm") ? (
            <span className="status-message-mark" aria-hidden="true">
              ▲{" "}
            </span>
          ) : null}
          {workItem.statusMessage}
        </p>
      )}
      {(canReset || canRetry) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {canReset && (
            <button
              type="button"
              className="icon-btn icon-btn--armed"
              disabled={actionsPending}
              onClick={() => reset.mutate()}
              aria-label={reset.isPending ? "Resetting job" : "Reset job"}
              title={reset.isPending ? "Resetting..." : "Reset"}
            >
              {reset.isPending ? (
                <svg
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="9"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                  <path
                    className="opacity-75"
                    d="M12 3a9 9 0 0 1 9 9"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="m19 6-1 14H6L5 6" />
                  <path d="M10 11v5" />
                  <path d="M14 11v5" />
                </svg>
              )}
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              className="plate-mini"
              disabled={actionsPending}
              onClick={() => retry.mutate()}
            >
              {retry.isPending
                ? retriesStatusChecks
                  ? "Retrying checks..."
                  : "Retrying..."
                : retriesStatusChecks
                  ? "Retry checks"
                  : "Retry"}
            </button>
          )}
        </div>
      )}
      {reset.isError && (
        <p className="mt-1.5 mb-0 text-xs text-oxblood-deep" role="alert">
          Could not reset this job.
        </p>
      )}
      {retry.isError && (
        <p className="mt-1.5 mb-0 text-xs text-oxblood-deep" role="alert">
          {retriesStatusChecks
            ? "Could not retry these checks."
            : "Could not retry this job."}
        </p>
      )}
    </div>
  )
}

function RepositoryIssuesSkeleton() {
  return (
    <div
      className="grid gap-2"
      role="status"
      aria-label="Loading issues"
      aria-busy="true"
    >
      <span className="block h-4 w-[85%] animate-pulse bg-paper-2 motion-reduce:animate-none" />
      <span className="block h-4 w-[65%] animate-pulse bg-paper-2 motion-reduce:animate-none" />
    </div>
  )
}

export function RepositoryCardsSkeleton() {
  return (
    <section
      className="grid grid-cols-1 gap-8"
      aria-label="Loading repositories"
      aria-busy="true"
    >
      {[0, 1].map((item) => (
        <div
          className="grid min-w-0 gap-4 border-t border-rule-2 py-5 first:border-t-0 first:pt-0"
          key={item}
        >
          <span className="block h-[0.85rem] w-[35%] animate-pulse bg-paper-2 motion-reduce:animate-none" />
          <span className="block h-[1.6rem] w-[65%] animate-pulse bg-paper-2 motion-reduce:animate-none" />
          <span className="block h-[0.85rem] w-[90%] animate-pulse bg-paper-2 motion-reduce:animate-none" />
        </div>
      ))}
    </section>
  )
}
