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
import { Copy } from "../copy.js"
import { forgeChangeRequestShort } from "../forge-change-request.js"
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
  completedWorkItemsHistoryQueryKeyPrefix,
  followRepositoryWorkItemsLive,
} from "../refresh-work-items-live.js"
import { type Repository, repositoriesQuery } from "../repositories-query.js"
import { sessionWorktreeParts } from "../session-worktree-line.js"
import { cx, ui } from "../ui.js"
import { workItemIssueUrl } from "../work-item-issue-url.js"
import { canShowWorkItemResetAction } from "../work-item-job-actions.js"
import { WorkItemOutcomePresentation } from "../work-item-outcome-presentation.js"
import {
  isStatusMessageAlarm,
  lifecycleLaneCssVars,
  lifecycleStepChipClassNameForStatus,
  statusBadgeClassNameForStatus,
  statusMessageClassNameForStatus,
} from "../work-item-progress-chrome.js"
import { workItemPullRequestUrl } from "../work-item-pull-request-url.js"
import { WorkItemResetButton } from "../work-item-reset-button.js"

// Re-export for callers that still import from the home route module.
export type { Repository } from "../repositories-query.js"
export { repositoriesQuery } from "../repositories-query.js"

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
 * Rolling window hours for Jobs Completed (same source as server filter).
 * Filtering uses Work Item stateReadyAt within JOBS_COMPLETED_WINDOW_MS on the API.
 * Kept in the query key so a window-hours change busts the client cache.
 */
const JOBS_COMPLETED_WINDOW_HOURS = jobsCompletedWindowHours
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

export const jobsCompletedWorkItemsQuery = (repositoryId: string) => {
  const base = workItemsQuery(repositoryId, {
    listKind: "COMPLETED",
  })
  return {
    ...base,
    queryKey: [...base.queryKey, JOBS_COMPLETED_WINDOW_HOURS] as const,
  }
}

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
          <span className={cx(ui.skeleton, "h-10", "w-[40%]")} />
          <span className={cx(ui.skeleton, "h-24")} />
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
              <span className={cx(ui.skeleton, "h-10", "w-[50%]")} />
              <span className={cx(ui.skeleton, "h-32")} />
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
      <section className={ui.repoCards} aria-label="Configured repositories">
        {repositories.map((repository) => (
          <RepositoryCard
            issuesChangeCount={issuesChangeCounts[repository.id] ?? 0}
            key={repository.id}
            repository={repository}
          />
        ))}
      </section>
      <div className="mt-10 sm:mt-12">
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
    <section className={ui.blankSlate} aria-label="Add a repository">
      {heading !== undefined ? (
        <>
          <span className={ui.kickerTag}>Setup</span>
          <h2 className={ui.blankSlateTitle}>{heading}</h2>
        </>
      ) : null}
      <form
        className={cx(
          ui.blankSlateForm,
          heading === undefined && ui.blankSlateFormFlush,
        )}
        onSubmit={onSubmit}
      >
        <label className="sr-only" htmlFor="add-repository-path">
          Local repository path
        </label>
        <div className={ui.blankSlatePathRow}>
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
            className={ui.blankSlateInput}
          />
          <div className={ui.blankSlateActions}>
            {directoryPickerAvailable ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => pickDirectory.mutate()}
                className={ui.plateMini}
              >
                {pickDirectory.isPending ? "Browsing…" : "Browse…"}
              </button>
            ) : null}
            <button
              type="submit"
              disabled={busy}
              className={ui.platePrimary}
              aria-busy={busy || undefined}
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
          <fieldset className={ui.blankSlateFieldset}>
            <legend>Confirm forge identity</legend>
            <label className={ui.blankSlateField}>
              Forge:
              <select
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
            <label className={ui.blankSlateField}>
              Forge host:
              <input
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
            <label className={ui.blankSlateField}>
              Project path:
              <input
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
            <p className={ui.blankSlateHint}>
              The project is verified against this forge before it is saved.
            </p>
          </fieldset>
        ) : null}
        {errorMessage !== null ? (
          <Banner
            className={cx(ui.bannerCompact, "w-full")}
            tone="alarm"
            tag="Error"
            role="alert"
          >
            {errorMessage}
          </Banner>
        ) : null}
      </form>
      <div className={ui.blankSlateDivider} aria-hidden="true">
        <span>or</span>
      </div>
      <p className={ui.blankSlateCli}>
        Add a local Git repository with the operator binary:
      </p>
      <code className={cx(ui.guidanceCode, "max-w-full", "overflow-x-auto")}>
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
  const pauseButtonClassName = cx(
    ui.iconBtn,
    pauseFailed && ui.iconBtnArmed,
    !pauseFailed && repository.paused && ui.iconBtnPaused,
  )
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
    <article className={ui.repoCard}>
      <div className={ui.repoCardHead}>
        <h2 className={ui.repoCardTitle}>
          <a
            className={ui.repoCardLink}
            href={`https://${repository.forgeHost}/${repository.projectPath}`}
          >
            {repositoryLabel}
          </a>
          <span
            className={ui.repoCardPrCount}
            title={pullRequestCountLabel}
            aria-busy={pullRequestCountLoading ? true : undefined}
          >
            <span className="sr-only">{pullRequestCountLabel}</span>
            <span aria-hidden="true">{pullRequestCountDisplay}</span>
          </span>
        </h2>
        <div className={ui.repoCardControls}>
          <CardCollapseToggle
            collapsed={repositoryCollapsed}
            onToggle={toggleRepositoryCollapsed}
            controlsId={repositoryBodyId}
            label={repositoryLabel}
          />
          <button
            type="button"
            className={pauseButtonClassName}
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
            ) : repository.paused ? (
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
          <span className="relative" data-repo-menu={repository.id}>
            <button
              type="button"
              className={ui.iconBtn}
              aria-label={`Actions for ${repository.projectPath}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="1.75" />
                <circle cx="12" cy="12" r="1.75" />
                <circle cx="12" cy="19" r="1.75" />
              </svg>
            </button>
            {menuOpen && (
              <div role="menu" className={cx(ui.menuPanel, "min-w-40")}>
                <button
                  type="button"
                  role="menuitem"
                  className={ui.menuItem}
                  onClick={() => {
                    setMenuOpen(false)
                    openSettings()
                  }}
                >
                  Settings
                </button>
                <hr className={ui.menuSep} />
                <button
                  type="button"
                  role="menuitem"
                  className={cx(ui.menuItem, ui.menuItemDestructive)}
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
        className={ui.dialogPanel}
        aria-labelledby={`repo-settings-title-${repository.id}`}
        onCancel={(event) => {
          if (updateSettings.isPending) event.preventDefault()
        }}
        onClose={() => setSettingsOpen(false)}
      >
        <form onSubmit={saveSettings}>
          <div className={ui.dialogHeader}>
            <p className={ui.dialogKicker}>Repository settings</p>
            <h2
              id={`repo-settings-title-${repository.id}`}
              className={cx(ui.dialogTitle, ui.dialogTitlePath)}
            >
              {repository.projectPath}
            </h2>
            <p className={ui.dialogLede}>
              Overrides apply on the next Agent Turn. Empty model fields use
              harness defaults for this Repository&apos;s effective Agent
              Backend.
            </p>
          </div>
          <div className={ui.dialogBody}>
            <fieldset className={ui.dialogFieldset}>
              <legend>Forge identity</legend>
              <label className={ui.dialogField}>
                Forge:
                <select
                  className={ui.dialogInput}
                  value={forge}
                  onChange={(event) =>
                    setForge(event.target.value as "github" | "gitlab")
                  }
                >
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                </select>
              </label>
              <label className={ui.dialogField}>
                Forge host:
                <input
                  className={cx(ui.dialogInput, ui.dialogInputMono)}
                  required
                  value={forgeHost}
                  onChange={(event) => setForgeHost(event.target.value)}
                />
              </label>
              <label className={ui.dialogField}>
                Project path:
                <input
                  className={cx(ui.dialogInput, ui.dialogInputMono)}
                  required
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                />
              </label>
              <span className={ui.dialogFieldHint}>
                GitLab identities are verified before Save. Identity changes are
                blocked after this Repository has any Work Item.
              </span>
            </fieldset>
            <label className={ui.dialogCheck}>
              <input
                type="checkbox"
                className="size-4"
                checked={paused}
                onChange={(event) => setPaused(event.target.checked)}
              />
              Paused
              <span className={ui.dialogFieldHint}>
                Skip autonomous work selection
              </span>
            </label>
            <label className={ui.dialogCheck}>
              <input
                type="checkbox"
                className="size-4"
                checked={autoMerge}
                onChange={(event) => setAutoMerge(event.target.checked)}
              />
              Auto-merge
              <span className={ui.dialogFieldHint}>
                Allow clanker merge when risk is low
              </span>
            </label>
            <label className={ui.dialogCheck}>
              <input
                type="checkbox"
                className="size-4"
                checked={includeAllIssueAuthors}
                onChange={(event) =>
                  setIncludeAllIssueAuthors(event.target.checked)
                }
              />
              Include all Issue Authors
              <span className={ui.dialogFieldHint}>
                Relevant Issues from every author after Refresh
              </span>
            </label>
            <label className={ui.dialogField}>
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={waitForReadyForReviewChecks}
                  onChange={(event) =>
                    setWaitForReadyForReviewChecks(event.target.checked)
                  }
                />
                Wait for checks to start after ready for review
              </span>
              <span className={ui.dialogFieldHint}>
                Wait up to 90 seconds for workflows that start after a PR is
                marked ready for review. If this repository has no such
                workflows, turn off this setting to skip the wait.
              </span>
            </label>

            <label className={ui.dialogField}>
              Agent Backend
              <select
                className={ui.dialogInput}
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
              <span className={ui.dialogFieldHint}>
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
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Error"
                role="alert"
              >
                Agent Backends list could not be loaded. You can still inherit
                the harness default; override options may be incomplete.
              </Banner>
            )}

            {usesPreviewCatalog && previewError !== null && (
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Error"
                role="alert"
              >
                Preview failed: {previewError}. Model fields stay disabled until
                preview succeeds.
                {backendDraftChanging
                  ? " Changing the effective backend cannot be saved until preview succeeds."
                  : " Non-model settings can still be saved."}
              </Banner>
            )}

            {modelsLoading ? (
              <p className={ui.dialogLoading}>Loading models...</p>
            ) : !usesPreviewCatalog && models.isError ? (
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Error"
                role="alert"
              >
                Models could not be loaded.
              </Banner>
            ) : (
              <>
                <label className={ui.dialogField}>
                  Build model
                  <select
                    className={cx(ui.dialogInput, ui.dialogInputMono)}
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
                  <Banner
                    className={ui.bannerCompact}
                    tone="alarm"
                    tag="Error"
                    role="alert"
                  >
                    Build effort (thinking) override is unavailable — the
                    selected model is not in the Agent Model catalog. Use
                    harness default or pick another model.
                  </Banner>
                ) : buildVariantSourceModel.length > 0 &&
                  buildVariants.length === 0 ? (
                  <p className={ui.dialogNote}>
                    Build effort (thinking) override is unavailable — this model
                    has no effort (thinking) options. Use harness default or
                    pick another model.
                  </p>
                ) : (
                  <label className={ui.dialogField}>
                    Build effort (thinking)
                    <select
                      className={ui.dialogInput}
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
                <label className={ui.dialogField}>
                  Review model
                  <select
                    className={cx(ui.dialogInput, ui.dialogInputMono)}
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
                  <Banner
                    className={ui.bannerCompact}
                    tone="alarm"
                    tag="Error"
                    role="alert"
                  >
                    Review effort (thinking) override is unavailable — the
                    selected model is not in the Agent Model catalog. Use
                    harness default or pick another model.
                  </Banner>
                ) : reviewThinkingLevelSourceModel.length > 0 &&
                  reviewThinkingLevels.length === 0 ? (
                  <p className={ui.dialogNote}>
                    Review effort (thinking) override is unavailable — this
                    model has no effort (thinking) options. Use harness default
                    or pick another model.
                  </p>
                ) : (
                  <label className={ui.dialogField}>
                    Review effort (thinking)
                    <select
                      className={ui.dialogInput}
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
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Error"
                role="alert"
              >
                {updateSettings.error instanceof Error
                  ? updateSettings.error.message
                  : "Settings could not be saved. Try again."}
              </Banner>
            )}
          </div>
          <div className={ui.dialogFooter}>
            <button
              type="button"
              className={ui.plateMini}
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
              className={ui.platePrimary}
              aria-busy={updateSettings.isPending || undefined}
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
              {updateSettings.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </dialog>
      {!repositoryCollapsed && (
        <div id={repositoryBodyId}>
          <dl className={ui.repoMeta}>
            <div className={ui.repoMetaRow}>
              <dt>Path</dt>
              <dd title={repository.localPath}>{repository.localPath}</dd>
            </div>
            <div className={ui.repoMetaRow}>
              <dt>Checkout</dt>
              <dd>{repository.isBare ? "Bare repository" : "Working tree"}</dd>
            </div>
            <div className={ui.repoMetaRow}>
              <dt>Agent Backend</dt>
              <dd>
                {repository.selectedAgentBackend === null
                  ? `Harness default (${repository.effectiveAgentBackend})`
                  : repository.effectiveAgentBackend}
              </dd>
            </div>
            <div className={ui.repoMetaRow}>
              <dt>Build model</dt>
              <dd>
                {repository.defaultModel ??
                  (repository.selectedAgentBackend === null
                    ? `Harness default (${
                        config.data?.defaultModel ?? "not configured"
                      })`
                    : "Harness default")}
                {" · "}
                {repository.defaultThinkingLevel ??
                  (repository.selectedAgentBackend === null
                    ? `Harness default (${
                        config.data?.defaultThinkingLevel ?? "not configured"
                      })`
                    : "Harness default")}
              </dd>
            </div>
            <div className={ui.repoMetaRow}>
              <dt>Review model</dt>
              <dd>
                {repository.reviewModel ??
                  (repository.selectedAgentBackend === null
                    ? `Harness default (${
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
                    ? `Harness default (${
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
            <div className={ui.repoMetaRow}>
              <dt>Auto-merge</dt>
              <dd>{repository.autoMerge ? "Enabled" : "Disabled"}</dd>
            </div>
            <div className={ui.repoMetaRow}>
              <dt>Include all Issue Authors</dt>
              <dd>
                {repository.includeAllIssueAuthors ? "Enabled" : "Disabled"}
              </dd>
            </div>
            <div className={ui.repoMetaRow}>
              <dt>Wait for ready checks</dt>
              <dd>
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
                    <button
                      type="button"
                      className={ui.platePrimary}
                      disabled={addGitHubToken.isPending}
                      aria-busy={addGitHubToken.isPending || undefined}
                      onClick={() => addGitHubToken.mutate()}
                    >
                      {addGitHubToken.isPending
                        ? "Waiting for Keymaxxer"
                        : "Store in Keymaxxer"}
                    </button>
                  ) : (
                    <a
                      className={ui.platePrimary}
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
                    <code className={ui.guidanceCode}>
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
                    <code className={ui.guidanceCode}>
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
                    <button
                      type="button"
                      className={ui.platePrimary}
                      disabled={addGitLabToken.isPending}
                      aria-busy={addGitLabToken.isPending || undefined}
                      onClick={() => addGitLabToken.mutate()}
                    >
                      {addGitLabToken.isPending
                        ? "Waiting for Keymaxxer"
                        : "Store in Keymaxxer"}
                    </button>
                  ) : (
                    <a
                      className={ui.platePrimary}
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
                      <code className={ui.guidanceCode}>
                        {repository.credential.githubTokenSecretName}
                      </code>{" "}
                      in Keymaxxer when available (provider{" "}
                      <code className={ui.guidanceCode}>gitlab</code>, account{" "}
                      <code className={ui.guidanceCode}>
                        {repository.forgeHost}/{repository.projectPath}
                      </code>
                      ). Or set ambient auth without Keymaxxer:{" "}
                    </>
                  ) : (
                    <>
                      Create a personal access token on this GitLab instance
                      with API access for{" "}
                      <code className={ui.guidanceCode}>
                        {repository.projectPath}
                      </code>
                      . Store it in Keymaxxer when available, or set ambient
                      auth:{" "}
                    </>
                  )}
                  <code className={ui.guidanceCode}>GITLAB_TOKEN</code> or{" "}
                  <code className={ui.guidanceCode}>
                    glab auth login --hostname {repository.forgeHost}
                  </code>{" "}
                  before starting the Harness.
                </p>
                {addGitLabToken.isError ? (
                  <p className="m-0 mt-1">
                    Keymaxxer setup was cancelled or failed. Use ambient{" "}
                    <code className={ui.guidanceCode}>GITLAB_TOKEN</code> or{" "}
                    <code className={ui.guidanceCode}>glab auth login</code> and
                    restart the Harness if Keymaxxer is unavailable.
                  </p>
                ) : null}
              </Banner>
            )}
          <div className={ui.repoIssues}>
            <div className={ui.repoIssuesHead}>
              <h3 className={ui.repoIssuesKicker}>Relevant issues</h3>
              <button
                type="button"
                className={ui.iconBtn}
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
                  className={
                    refreshingIssues
                      ? "animate-spin motion-reduce:animate-none"
                      : undefined
                  }
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
              <Banner
                className={cx(ui.bannerCompact, "mb-2")}
                tone="alarm"
                tag="Error"
                role="alert"
              >
                Failed to refresh issues.
              </Banner>
            )}
            {repository.issuesReconciledAt === null ? (
              <p className={ui.repoIssuesEmpty}>Not refreshed yet.</p>
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
            <Banner
              className={cx(ui.bannerCompact, "mt-3")}
              tone="alarm"
              tag="Error"
              role="alert"
            >
              Could not remove repository. Please try again.
            </Banner>
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
  // One Session usage dialog for the whole list (not per issue row) so the
  // fixed session-usage-title id stays unique — same pattern as Kanban/Completed.
  const [sessionDialog, setSessionDialog] = useState<{
    workItemId: string
    sessionId: string
  } | null>(null)
  const onOpenSession = (workItemId: string, sessionId: string) => {
    setSessionDialog({ workItemId, sessionId })
  }

  if (issues.length === 0) {
    return (
      <p className={ui.repoIssuesEmpty}>
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
    <>
      <ul className={ui.repoIssuesList}>
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
                onOpenSession={onOpenSession}
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
              onOpenSession={onOpenSession}
            />
          )
        })}
      </ul>
      <SessionUsageDialog
        workItemId={sessionDialog?.workItemId ?? null}
        sessionId={sessionDialog?.sessionId ?? null}
        open={sessionDialog !== null}
        onClose={() => setSessionDialog(null)}
      />
    </>
  )
}

function ParentIssueGroup({
  parent,
  childIssues,
  closedChildren,
  repository,
  workItems,
  workItemsLoading,
  onOpenSession,
}: {
  parent: RepositoryIssue
  childIssues: readonly RepositoryIssue[]
  closedChildren: number
  repository: Repository
  workItems: readonly WorkItem[]
  workItemsLoading: boolean
  readonly onOpenSession: (workItemId: string, sessionId: string) => void
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
      <details className={ui.parentIssue} open>
        <summary className={ui.parentIssueSummary}>
          <span className={ui.repoIssueNum}>#{parent.issueNumber}</span>
          <span className="min-w-0">
            <a
              className={ui.repoIssueTitle}
              href={parent.url}
              onClick={(event) => event.stopPropagation()}
            >
              {parent.title}
            </a>
            {parent.issueAuthor !== null && parent.issueAuthor !== "" && (
              <span className={ui.repoIssueAuthor}>{parent.issueAuthor}</span>
            )}
          </span>
          <span className={ui.parentIssueSummaryActions}>
            <span className={ui.parentIssueClosedCount}>
              {closedChildren}/{childIssues.length} closed
            </span>
            <svg
              aria-hidden="true"
              className={ui.parentIssueChevron}
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
                // Error Banner is in-flow under the summary (not under the kebab).
                errorMessage={null}
                onImplementAllWithAutoMerge={() => implementAll.mutate()}
              />
            )}
          </span>
        </summary>
        {implementAll.isError && (
          <Banner
            className={cx(ui.bannerCompact, ui.parentIssueError)}
            tone="alarm"
            tag="Error"
            role="alert"
          >
            Could not start Implement all with auto-merge. Refresh the issues
            and try again.
          </Banner>
        )}
        <ul className={ui.parentIssueChildren}>
          {childIssues.map((child) => (
            <RepositoryIssueRow
              issue={child}
              key={child.id}
              repository={repository}
              workItems={workItems}
              workItemsLoading={workItemsLoading}
              onOpenSession={onOpenSession}
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
  onOpenSession,
}: {
  issue: RepositoryIssue
  repository: Repository
  workItems: readonly WorkItem[]
  workItemsLoading: boolean
  readonly onOpenSession: (workItemId: string, sessionId: string) => void
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
    <li className={ui.repoIssue}>
      <div className={ui.repoIssueRow}>
        <span className={ui.repoIssueNum}>#{issue.issueNumber}</span>
        <span className="min-w-0">
          <a className={ui.repoIssueTitle} href={issue.url}>
            {issue.title}
          </a>
          {issue.issueAuthor !== null && issue.issueAuthor !== "" && (
            <span className={ui.repoIssueAuthor}>{issue.issueAuthor}</span>
          )}
        </span>
        <span className={ui.repoIssueActions}>
          {issue.state === "CLOSED" && (
            <span className={cx(ui.stamp, ui.stampClosed)}>Closed</span>
          )}
          {issue.blockedBy.length > 0 && (
            <span className={cx(ui.stamp, ui.stampBlocked)}>Blocked</span>
          )}
          {(canImplement || canQueue) && (
            <span className="relative" data-issue-menu={issue.id}>
              <button
                type="button"
                className={ui.iconBtn}
                aria-label={`Actions for issue #${issue.issueNumber}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="1.75" />
                  <circle cx="12" cy="12" r="1.75" />
                  <circle cx="12" cy="19" r="1.75" />
                </svg>
              </button>
              {menuOpen && (
                <div role="menu" className={cx(ui.menuPanel, "min-w-44")}>
                  {canImplement && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className={ui.menuItem}
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
                        className={ui.menuItem}
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
                      className={ui.menuItem}
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
          collapseEarlierLanes
          forge={repository.forge}
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
          onOpenSession={onOpenSession}
        />
      )}
      {(implementNow.isError ||
        implementLocally.isError ||
        queueIssue.isError) && (
        <Banner
          className={cx(ui.bannerCompact, ui.repoIssueError)}
          tone="alarm"
          tag="Error"
          role="alert"
        >
          {queueIssue.isError
            ? "Could not queue issue. Refresh the issues and try again."
            : "Could not start implementation. Refresh the issues and try again."}
        </Banner>
      )}
      {issue.blockedBy.length > 0 && (
        <p className={ui.repoIssueBlockedBy}>
          Blocked by{" "}
          {issue.blockedBy.map((blocker, index) => (
            <span key={blocker.issueUrl}>
              {index > 0 && ", "}
              <a href={blocker.issueUrl}>#{blocker.issueNumber}</a>
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
      className={cx(ui.dialogPanel, ui.dialogPanelNarrow)}
      aria-labelledby="session-usage-title"
      onClose={onClose}
    >
      <div className={cx(ui.dialogHeader, ui.dialogHeaderCompact)}>
        <p className={ui.dialogKicker}>Session usage</p>
        <h2
          id="session-usage-title"
          className={cx(ui.dialogTitle, ui.dialogTitleSm)}
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
      <div className={cx(ui.dialogBody, ui.dialogBodyCompact)}>
        {!enabled ? null : session.isPending ? (
          <p className={ui.dialogLoading}>Loading usage…</p>
        ) : session.isError ? (
          <Banner
            className={ui.bannerCompact}
            tone="alarm"
            tag="Error"
            role="alert"
          >
            Could not load Session usage. Close and try again.
          </Banner>
        ) : session.data === null || session.data === undefined ? (
          <Banner
            className={ui.bannerCompact}
            tone="guidance"
            tag="Session"
            role="status"
          >
            Work Item not found.
          </Banner>
        ) : session.data.availability === "UNSUPPORTED" ? (
          <Banner
            className={ui.bannerCompact}
            tone="guidance"
            tag="Session"
            role="status"
          >
            {session.data.backend.label} does not provide Session Telemetry.
          </Banner>
        ) : session.data.availability === "MISSING" ? (
          <Banner
            className={ui.bannerCompact}
            tone="guidance"
            tag="Session"
            role="status"
          >
            {session.data.backend.label} no longer has this Session locally.
            Usage cannot be loaded.
          </Banner>
        ) : session.data.availability === "UNAVAILABLE" ? (
          <div className="grid gap-3">
            <Banner
              className={ui.bannerCompact}
              tone="guidance"
              tag="Session"
              role="status"
            >
              {session.data.backend.label} Session Telemetry is temporarily
              unavailable. Retry in a moment.
            </Banner>
            <button
              type="button"
              className={cx(ui.plateMini, "justify-self-start")}
              onClick={() => {
                void session.refetch()
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <table className={ui.dialogTable}>
            <tbody>
              <tr>
                <th scope="row">Model</th>
                <td>
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
              <tr>
                <th scope="row">Input tokens</th>
                <td>{formatTokenCount(session.data.tokens?.input ?? 0)}</td>
              </tr>
              <tr>
                <th scope="row">Output tokens</th>
                <td>{formatTokenCount(session.data.tokens?.output ?? 0)}</td>
              </tr>
              <tr>
                <th scope="row">Reasoning tokens</th>
                <td>{formatTokenCount(session.data.tokens?.reasoning ?? 0)}</td>
              </tr>
              <tr>
                <th scope="row">Cache read</th>
                <td>{formatTokenCount(session.data.tokens?.cacheRead ?? 0)}</td>
              </tr>
              <tr>
                <th scope="row">Cache write</th>
                <td>
                  {formatTokenCount(session.data.tokens?.cacheWrite ?? 0)}
                </td>
              </tr>
              <tr>
                <th scope="row">Cost</th>
                <td>
                  {session.data.cost === null || session.data.cost === undefined
                    ? "—"
                    : formatSessionCost(session.data.cost)}
                </td>
              </tr>
              <tr>
                <th scope="row">Created</th>
                <td>{formatSessionInstant(session.data.createdAt)}</td>
              </tr>
              <tr>
                <th scope="row">Updated</th>
                <td>{formatSessionInstant(session.data.updatedAt)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      <div className={cx(ui.dialogFooter, ui.dialogFooterCompact)}>
        <button
          type="button"
          className={ui.plateMini}
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
      className="border border-line-ghost bg-panel px-4 py-3 sm:px-5"
      role="status"
      aria-label="Loading jobs"
      aria-busy="true"
    >
      <div className="grid gap-2">
        <span className={cx(ui.skeleton, "h-12")} />
        <span className={cx(ui.skeleton, "h-12")} />
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

  const pauseClass = cx(
    ui.iconBtn,
    failed && ui.iconBtnArmed,
    !failed && workItem.paused && ui.iconBtnPaused,
  )

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
   * Collapse earlier Build/Review/PR lane chips into summary rows (▸ BUILD ·
   * 5m). Used on Kanban tickets and repos issue chrome; leave off for full
   * lists. Terminal COMPLETE also collapses the PR|MR lane (all reached
   * journey legs) so finished runs match archive-style condensed chrome.
   */
  collapseEarlierLanes = false,
  /**
   * Repository forge for PR vs MR lane summary labels on collapsed COMPLETE
   * chrome. Optional; defaults to GitHub wording.
   */
  forge = null,
  pullRequestUrl = null,
  issueUrl = null,
  /**
   * When false, outcome chrome omits the PR badge (Kanban promotes it into
   * the top status row for Needs Human + PR). Default true keeps repository
   * rows and non-promoted tickets unchanged.
   */
  showPullRequestBadge = true,
  onOpenSession,
}: {
  workItem: WorkItem
  compact?: boolean
  collapseEarlierLanes?: boolean
  forge?: string | null
  pullRequestUrl?: string | null
  issueUrl?: string | null
  showPullRequestBadge?: boolean
  /** Opens Session usage for a session id (repos / non-compact chrome). */
  onOpenSession?: (workItemId: string, sessionId: string) => void
}) {
  const queryClient = useQueryClient()
  const status = workItem.status
  const heldForBlockers = status === "WAITING_FOR_BLOCKERS"
  const { sessionId, worktreePath } = sessionWorktreeParts(
    workItem.sessionId,
    workItem.worktreePath,
  )
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
  // Terminal COMPLETE only: collapse every reached lane (including PR|MR), not
  // only earlier-than-focus. Do not use status === "SUCCEEDED" — that is the
  // latest step-run outcome and can appear mid-lifecycle while state is still
  // operational (repos would then hide the focus strip). Non-complete work
  // keeps focus-lane chips expanded.
  const collapseAllReachedLanes =
    collapseEarlierLanes &&
    (status === "COMPLETE" || workItem.state === "COMPLETE")
  const focusLane =
    collapseEarlierLanes && !collapseAllReachedLanes
      ? lifecycleFocusLaneFor(workItem)
      : null
  const chipBlocks = planLifecycleChipPresentation(workItem.lifecycleLabels, {
    collapseEarlierLanes,
    focusLane,
    expandedEarlierLanes,
    collapseAllReachedLanes,
    prLaneLabel: forgeChangeRequestShort(forge),
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
    const duration =
      displayDurationMs !== null ? (
        <span className="ml-1 shrink-0 opacity-90">
          · {formatDuration(displayDurationMs)}
        </span>
      ) : null
    const chipTitle =
      displayDurationMs !== null
        ? `${lifecycleLabel.label} · ${formatDuration(displayDurationMs)}`
        : lifecycleLabel.label
    return (
      <li key={lifecycleLabel.phase} className="min-w-0 max-w-full">
        {linkToPullRequest ? (
          <a
            className={`${chipClassName} hover:underline`}
            href={pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${openPullRequestLabel}: ${lifecycleLabel.label}`}
            title={chipTitle}
            style={chipStyle}
          >
            <span className="min-w-0 truncate">{lifecycleLabel.label}</span>
            {duration}
          </a>
        ) : (
          <span className={chipClassName} style={chipStyle} title={chipTitle}>
            <span className="min-w-0 truncate">{lifecycleLabel.label}</span>
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
        options?.className ??
        "mt-2 mb-0 flex min-w-0 max-w-full list-none flex-wrap gap-1 p-0"
      }
      aria-label={options?.ariaLabel ?? "Lifecycle steps"}
    >
      {chips.map(renderLifecycleChip)}
    </ol>
  )

  return (
    <div
      className={cx(compact ? "mt-2" : ui.lifecycleInset, "min-w-0 max-w-full")}
    >
      {/*
       * Non-compact (repos): same runtime lines as kanban tickets — agent
       * backend, session id (Session usage + copy), worktree path + copy.
       * Compact kanban tickets render these above this component.
       */}
      {!compact ? (
        <div className={cx(ui.jobTicketRuntime, "mb-1")}>
          <p className={ui.jobTicketRuntimeLine}>
            {workItem.agentBackend.label}
          </p>
          {sessionId !== null ? (
            <div
              className={cx(
                ui.jobTicketRuntimeLine,
                "flex min-w-0 max-w-full items-center gap-1",
              )}
            >
              {onOpenSession !== undefined ? (
                <button
                  type="button"
                  className={cx(ui.jobTicketSession, "min-w-0 flex-1 truncate")}
                  title={sessionId}
                  onClick={() => onOpenSession(workItem.id, sessionId)}
                >
                  {sessionId}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate" title={sessionId}>
                  {sessionId}
                </span>
              )}
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
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={cx(
            ui.jobTicketRuntimeLine,
            "uppercase",
            "tracking-[0.1em]",
          )}
        >
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
          showPullRequestBadge={showPullRequestBadge}
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
                      className={ui.legSummary}
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
                          "mt-1 mb-0 flex min-w-0 max-w-full list-none flex-wrap gap-1 p-0",
                        ariaLabel: `${block.laneLabel} lifecycle steps`,
                      })}
                  </div>
                )
              }
              if (block.kind === "focus-lane") {
                if (block.chips.length === 0) return null
                return (
                  <div key="focus-lane" className="min-w-0 max-w-full">
                    {renderChipList(block.chips, {
                      className:
                        "m-0 flex min-w-0 max-w-full list-none flex-wrap gap-1 p-0",
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
          {isStatusMessageAlarm(status) ? (
            <span className={ui.statusMessageMark} aria-hidden="true">
              ▲{" "}
            </span>
          ) : null}
          {workItem.statusMessage}
        </p>
      )}
      {(canReset || canRetry) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {canReset && (
            <WorkItemResetButton
              pending={reset.isPending}
              disabled={actionsPending}
              onReset={() => reset.mutate()}
            />
          )}
          {canRetry && (
            <button
              type="button"
              className={ui.plateMini}
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
        <Banner
          className={cx(ui.bannerCompact, "mt-1.5")}
          tone="alarm"
          tag="Error"
          role="alert"
        >
          Could not reset this job.
        </Banner>
      )}
      {retry.isError && (
        <Banner
          className={cx(ui.bannerCompact, "mt-1.5")}
          tone="alarm"
          tag="Error"
          role="alert"
        >
          {retriesStatusChecks
            ? "Could not retry these checks."
            : "Could not retry this job."}
        </Banner>
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
      <span className={cx(ui.skeleton, "h-4", "w-[85%]")} />
      <span className={cx(ui.skeleton, "h-4", "w-[65%]")} />
    </div>
  )
}

export function RepositoryCardsSkeleton() {
  return (
    <section
      className={ui.repoCards}
      aria-label="Loading repositories"
      aria-busy="true"
    >
      {[0, 1].map((item) => (
        <div className={ui.repoCardSkeleton} key={item}>
          <span className={cx(ui.skeleton, "h-[0.85rem]", "w-[35%]")} />
          <span className={cx(ui.skeleton, "h-[1.6rem]", "w-[65%]")} />
          <span className={cx(ui.skeleton, "h-[0.85rem]", "w-[90%]")} />
        </div>
      ))}
    </section>
  )
}
