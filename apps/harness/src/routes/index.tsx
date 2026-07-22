import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type FormEvent, Suspense, useEffect, useRef, useState } from "react"
import { createClient } from "@ready-for-agent/graphql-client"
import {
  jobsCardCollapseId,
  repositoryCardCollapseId,
  useCardCollapsed,
} from "../card-collapse.js"
import { CardCollapseToggle } from "../card-collapse-toggle.js"
import { Copy } from "../copy.js"
import {
  formatDuration,
  formatStartedAgo,
  isLiveDurationStatus,
  liveDurationMs,
  useNowMs,
} from "../live-duration.js"
import { localCommittedPullRequestDayBounds } from "../local-day-bounds.js"
import { followRepositoryIssuesLive } from "../refresh-issues-live.js"
import { followRepositoryWorkItemsLive } from "../refresh-work-items-live.js"
import { streamRepositoryChanges } from "../repository-live.js"
import { sessionWorktreeParts } from "../session-worktree-line.js"
import { workItemIssueUrl } from "../work-item-issue-url.js"
import { WorkItemOutcomePresentation } from "../work-item-outcome-presentation.js"
import { workItemPullRequestUrl } from "../work-item-pull-request-url.js"

const graphql = createClient({ url: "/graphql", batch: true })

const configQuery = {
  queryKey: ["config"],
  queryFn: async () => {
    const result = await graphql.query({
      config: {
        defaultModel: true,
        defaultVariant: true,
        reviewModel: true,
        reviewVariant: true,
      },
    })
    return result.config
  },
}

type OpencodeModelOption = {
  id: string
  variants: readonly string[]
}

const modelsQuery = {
  queryKey: ["models"],
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  queryFn: async () => {
    const result = await graphql.query({
      models: { id: true, variants: true },
    })
    return result.models
  },
}

const variantsForModel = (
  models: readonly OpencodeModelOption[] | undefined,
  modelId: string,
): readonly string[] => {
  if (modelId.length === 0 || models === undefined) return []
  return models.find((model) => model.id === modelId)?.variants ?? []
}

const formatVariantLabel = (variant: string): string =>
  `${variant[0]?.toUpperCase() ?? ""}${variant.slice(1)}`

const reconcileVariantForModel = (
  variant: string,
  modelVariants: readonly string[],
): string =>
  variant.length > 0 && modelVariants.includes(variant) ? variant : ""

const repositoriesQuery = {
  queryKey: ["repositories"],
  queryFn: async () => {
    const result = await graphql.query({
      repositories: {
        id: true,
        githubOwner: true,
        githubRepo: true,
        localPath: true,
        isBare: true,
        paused: true,
        defaultModel: true,
        defaultVariant: true,
        reviewModel: true,
        reviewVariant: true,
        autoMerge: true,
        includeAllIssueAuthors: true,
        issuesReconciledAt: true,
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

const addRepositoryCommandQuery = {
  queryKey: ["addRepositoryCommand"],
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  queryFn: async () => {
    const result = await graphql.query({ addRepositoryCommand: true })
    return result.addRepositoryCommand
  },
}

const issuesQuery = (repositoryId: string) => ({
  queryKey: ["issues", repositoryId],
  queryFn: async () => {
    const result = await graphql.query({
      issues: {
        __args: { repositoryId },
        id: true,
        repositoryId: true,
        githubIssueNumber: true,
        title: true,
        url: true,
        state: true,
        issueAuthor: true,
        parent: {
          githubIssueNumber: true,
          githubIssueUrl: true,
        },
        hasChildren: true,
        blockedBy: {
          githubIssueNumber: true,
          githubIssueUrl: true,
        },
      },
    })
    return result.issues
  },
})

type Repository = {
  id: string
  githubOwner: string
  githubRepo: string
  localPath: string
  isBare: boolean
  paused: boolean
  defaultModel: string | null
  defaultVariant: string | null
  reviewModel: string | null
  reviewVariant: string | null
  autoMerge: boolean
  includeAllIssueAuthors: boolean
  issuesReconciledAt: string | null
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
  githubIssueNumber: number
  title: string
  url: string
  state: "OPEN" | "CLOSED"
  issueAuthor: string | null
  parent: {
    githubIssueNumber: number
    githubIssueUrl: string
  } | null
  hasChildren: boolean
  blockedBy: readonly {
    githubIssueNumber: number
    githubIssueUrl: string
  }[]
}

type WorkItemState =
  | "CREATE_WORKTREE"
  | "INSTALL_DEPENDENCIES"
  | "IMPLEMENT"
  | "ASSESS_CHANGES"
  | "PRE_COMMIT"
  | "REVIEW"
  | "COMMIT"
  | "CREATE_PR"
  | "WATCH_PR_STATUS_CHECKS"
  | "RESOLVE_PR_MERGE_CONFLICT"
  | "INVESTIGATE_PR_STATUS_CHECKS"
  | "MARK_PR_READY_FOR_REVIEW"
  | "DECIDE_PR_MERGE"
  | "MERGE_PR"
  | "CLOSE_ISSUE"
  | "LOCAL_CLEANUP"
  | "COMPLETE"
  | "FAILED"
  | "ABANDONED"
  | "NEEDS_HUMAN"

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

type WorkItem = {
  id: string
  repositoryId: string
  githubIssueNumber: number
  issueTitle: string | null
  githubPullRequestNumber: number | null
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
  githubIssueNumber: true,
  issueTitle: true,
  githubPullRequestNumber: true,
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

/** Completed history window (successful finished outcomes). */
const JOBS_COMPLETED_LIMIT = 15
/** Failed history window, independent of JOBS_COMPLETED_LIMIT. */
const JOBS_FAILED_LIMIT = 15

const workItemsQuery = (
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

const jobsWorkingWorkItemsQuery = (repositoryId: string) =>
  workItemsQuery(repositoryId, { listKind: "WORKING" })

const jobsFailedWorkItemsQuery = (repositoryId: string) =>
  workItemsQuery(repositoryId, {
    listKind: "FAILED",
    limit: JOBS_FAILED_LIMIT,
  })

const jobsCompletedWorkItemsQuery = (repositoryId: string) =>
  workItemsQuery(repositoryId, {
    listKind: "COMPLETED",
    limit: JOBS_COMPLETED_LIMIT,
  })

const committedPullRequestsCountQuery = (from: string, to: string) => ({
  queryKey: ["committed-pull-requests-count", from, to] as const,
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

function HomePage() {
  return (
    <main>
      <header className="my-8 sm:my-14">
        <p className="text-xs font-extrabold tracking-[0.12em] text-blue-600 uppercase">
          Console
        </p>
        <h1 className="mt-0.5 text-[clamp(2rem,5vw,3.5rem)] leading-[1.05] font-bold tracking-[-0.045em]">
          Clanker Harness
        </h1>
      </header>
      <Suspense fallback={<RepositoryCardsSkeleton />}>
        <HomeBody />
      </Suspense>
    </main>
  )
}

function HomeBody() {
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)
  const { collapsed: jobsCollapsed, toggleCollapsed: toggleJobsCollapsed } =
    useCardCollapsed(jobsCardCollapseId())
  const jobsBodyId = "jobs-card-body"

  if (repositories.length === 0) {
    return <RepositoryCards />
  }

  return (
    <>
      <section aria-label="Committed pull requests" className="mb-8">
        <CommittedPullRequestsDashboard />
      </section>
      <section aria-label="Jobs">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="m-0 text-lg font-bold tracking-[-0.02em] text-slate-900">
            Jobs
          </h2>
          <CardCollapseToggle
            collapsed={jobsCollapsed}
            onToggle={toggleJobsCollapsed}
            controlsId={jobsBodyId}
            label="Jobs"
          />
        </div>
        {!jobsCollapsed && (
          <div id={jobsBodyId}>
            <Suspense fallback={<JobsCardSkeleton />}>
              <JobsCard />
            </Suspense>
          </div>
        )}
      </section>
      <div className="mt-8">
        <RepositoryCards />
      </div>
    </>
  )
}

function CommittedPullRequestsDashboard() {
  const bounds = localCommittedPullRequestDayBounds()
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
  const loading =
    todayQuery.isLoading ||
    yesterdayQuery.isLoading ||
    thisWeekQuery.isLoading ||
    lastWeekQuery.isLoading
  const failed =
    todayQuery.isError ||
    yesterdayQuery.isError ||
    thisWeekQuery.isError ||
    lastWeekQuery.isError

  if (loading) {
    return (
      <article
        className="rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]"
        role="status"
        aria-label="Loading committed pull requests"
        aria-busy="true"
      >
        <div className="grid grid-cols-4 gap-4">
          <span className="block h-12 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none" />
          <span className="block h-12 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none" />
          <span className="block h-12 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none" />
          <span className="block h-12 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none" />
        </div>
      </article>
    )
  }

  if (failed) {
    return (
      <article className="rounded-[0.9rem] border border-red-200 bg-red-50 p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
        <p className="m-0 text-sm text-red-700" role="alert">
          Could not load committed pull requests. Please try again.
        </p>
      </article>
    )
  }

  const today = todayQuery.data ?? 0
  const yesterday = yesterdayQuery.data ?? 0
  const thisWeek = thisWeekQuery.data ?? 0
  const lastWeek = lastWeekQuery.data ?? 0

  return (
    <article className="rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
      <div className="grid grid-cols-4 gap-4">
        <div>
          <p className="m-0 text-xs font-bold tracking-wide text-slate-500 uppercase">
            Today
          </p>
          <p className="mt-1 mb-0 text-2xl font-bold tracking-[-0.03em] text-slate-900 tabular-nums">
            {today}
          </p>
        </div>
        <div>
          <p className="m-0 text-xs font-bold tracking-wide text-slate-500 uppercase">
            Yesterday
          </p>
          <p className="mt-1 mb-0 text-2xl font-bold tracking-[-0.03em] text-slate-900 tabular-nums">
            {yesterday}
          </p>
        </div>
        <div>
          <p className="m-0 text-xs font-bold tracking-wide text-slate-500 uppercase">
            This week
          </p>
          <p className="mt-1 mb-0 text-2xl font-bold tracking-[-0.03em] text-slate-900 tabular-nums">
            {thisWeek}
          </p>
        </div>
        <div>
          <p className="m-0 text-xs font-bold tracking-wide text-slate-500 uppercase">
            Last week
          </p>
          <p className="mt-1 mb-0 text-2xl font-bold tracking-[-0.03em] text-slate-900 tabular-nums">
            {lastWeek}
          </p>
        </div>
      </div>
    </article>
  )
}

function RepositoryCards() {
  const queryClient = useQueryClient()
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)
  const { data: addRepositoryCommand } = useSuspenseQuery(
    addRepositoryCommandQuery,
  )
  const [liveUpdatesUnavailable, setLiveUpdatesUnavailable] = useState(false)
  const [issuesChangeCounts, setIssuesChangeCounts] = useState<
    Readonly<Record<string, number>>
  >({})
  const repositoryIdsRef = useRef(repositories.map(({ id }) => id))
  repositoryIdsRef.current = repositories.map(({ id }) => id)

  useEffect(() => {
    let cancelled = false
    let controller: AbortController | undefined
    let finishRetry: (() => void) | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let warningTimer: ReturnType<typeof setTimeout> | undefined

    const startWarningTimer = () => {
      warningTimer ??= setTimeout(() => {
        if (!cancelled) setLiveUpdatesUnavailable(true)
      }, 10_000)
    }
    const refresh = async () => {
      await queryClient.fetchQuery({ ...repositoriesQuery, staleTime: 0 })
      if (cancelled) return
      if (warningTimer !== undefined) clearTimeout(warningTimer)
      warningTimer = undefined
      setLiveUpdatesUnavailable(false)
    }
    const subscribe = async () => {
      startWarningTimer()
      while (!cancelled) {
        controller = new AbortController()
        try {
          await streamRepositoryChanges({
            signal: controller.signal,
            onConnected: refresh,
            onChange: refresh,
          })
        } catch {
          if (cancelled) return
        }
        controller.abort()
        startWarningTimer()
        await new Promise<void>((resolve) => {
          finishRetry = resolve
          retryTimer = setTimeout(resolve, 1_000)
        })
        finishRetry = undefined
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh().catch(startWarningTimer)
      }
    }

    document.addEventListener("visibilitychange", refreshWhenVisible)
    void subscribe()

    return () => {
      cancelled = true
      controller?.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      finishRetry?.()
      if (warningTimer !== undefined) clearTimeout(warningTimer)
      document.removeEventListener("visibilitychange", refreshWhenVisible)
    }
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

  const warning = liveUpdatesUnavailable ? (
    <p
      className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      role="status"
    >
      Live updates are unavailable. Repository information may be out of date.
    </p>
  ) : null

  if (repositories.length === 0) {
    return (
      <>
        {warning}
        <div className="rounded-[0.9rem] border border-dashed border-slate-300 px-6 py-12 text-center">
          <h2 className="m-0">No repositories configured</h2>
          <p className="mt-1.5 text-slate-500">
            Add a local Git repository with the operator binary:
          </p>
          <code className="mt-3 inline-block rounded-md bg-slate-100 px-3 py-2 font-mono text-sm text-slate-800">
            {addRepositoryCommand}
          </code>
        </div>
      </>
    )
  }

  return (
    <>
      {warning}
      <section
        className="grid grid-cols-1 gap-4 md:grid-cols-2"
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
    </>
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
  const [menuOpen, setMenuOpen] = useState(false)
  const [awaitingRefresh, setAwaitingRefresh] = useState(false)
  const issuesChangeCountOnRefresh = useRef(issuesChangeCount)
  const settingsDialogRef = useRef<HTMLDialogElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const config = useQuery({ ...configQuery, enabled: settingsOpen })
  const models = useQuery({ ...modelsQuery, enabled: settingsOpen })
  const [paused, setPaused] = useState(repository.paused)
  const [defaultModel, setDefaultModel] = useState(
    repository.defaultModel ?? "",
  )
  const [defaultVariant, setDefaultVariant] = useState(
    repository.defaultVariant ?? "",
  )
  const [reviewModel, setReviewModel] = useState(repository.reviewModel ?? "")
  const [reviewVariant, setReviewVariant] = useState(
    repository.reviewVariant ?? "",
  )
  const [autoMerge, setAutoMerge] = useState(repository.autoMerge)
  const [includeAllIssueAuthors, setIncludeAllIssueAuthors] = useState(
    repository.includeAllIssueAuthors,
  )
  const jobsQuery = workItemsQuery(repository.id)
  const { data: workItems = [], isLoading: workItemsLoading } =
    useQuery(jobsQuery)

  const updateSettings = useMutation({
    mutationFn: async (input: {
      repositoryId: string
      paused: boolean
      defaultModel: string | null
      defaultVariant: string | null
      reviewModel: string | null
      reviewVariant: string | null
      autoMerge: boolean
      includeAllIssueAuthors: boolean
    }) => {
      const result = await graphql.mutation({
        updateRepositorySettings: {
          __args: { input },
          id: true,
          githubOwner: true,
          githubRepo: true,
          localPath: true,
          isBare: true,
          paused: true,
          defaultModel: true,
          defaultVariant: true,
          reviewModel: true,
          reviewVariant: true,
          autoMerge: true,
          includeAllIssueAuthors: true,
          issuesReconciledAt: true,
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
      settingsDialogRef.current?.close()
      setSettingsOpen(false)
    },
  })

  const openSettings = () => {
    setSettingsOpen(true)
    setPaused(repository.paused)
    setDefaultModel(repository.defaultModel ?? "")
    setDefaultVariant(repository.defaultVariant ?? "")
    setReviewModel(repository.reviewModel ?? "")
    setReviewVariant(repository.reviewVariant ?? "")
    setAutoMerge(repository.autoMerge)
    setIncludeAllIssueAuthors(repository.includeAllIssueAuthors)
    updateSettings.reset()
    if (config.isError) void config.refetch()
    if (models.isError) void models.refetch()
    settingsDialogRef.current?.showModal()
  }

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    updateSettings.mutate({
      repositoryId: repository.id,
      paused,
      defaultModel: defaultModel.trim() === "" ? null : defaultModel,
      defaultVariant: defaultVariant.trim() === "" ? null : defaultVariant,
      reviewModel: reviewModel.trim() === "" ? null : reviewModel,
      reviewVariant: reviewVariant.trim() === "" ? null : reviewVariant,
      autoMerge,
      includeAllIssueAuthors,
    })
  }

  const harnessDefaultModel = config.data?.defaultModel ?? "not configured"
  const harnessDefaultVariant = config.data?.defaultVariant ?? "not configured"
  const resolvedBuildModel = repository.defaultModel ?? harnessDefaultModel
  const resolvedBuildVariant =
    repository.defaultVariant ?? harnessDefaultVariant
  const harnessReviewModel =
    config.data?.reviewModel ?? `Build (${resolvedBuildModel})`
  const harnessReviewVariant =
    config.data?.reviewVariant ?? `Build (${resolvedBuildVariant})`
  const modelIds = (models.data ?? []).map((model) => model.id)
  const buildVariantSourceModel =
    defaultModel.length > 0 ? defaultModel : (config.data?.defaultModel ?? "")
  const reviewVariantSourceModel =
    reviewModel.length > 0
      ? reviewModel
      : defaultModel.length > 0
        ? defaultModel
        : (config.data?.reviewModel ?? config.data?.defaultModel ?? "")
  const buildVariants = variantsForModel(models.data, buildVariantSourceModel)
  const reviewVariants = variantsForModel(models.data, reviewVariantSourceModel)
  const hasUnavailableBuildModel =
    defaultModel.length > 0 && !modelIds.includes(defaultModel)
  const hasUnavailableReviewModel =
    reviewModel.length > 0 && !modelIds.includes(reviewModel)
  const buildVariantSourceUnavailable =
    buildVariantSourceModel.length > 0 &&
    !modelIds.includes(buildVariantSourceModel)
  const reviewVariantSourceUnavailable =
    reviewVariantSourceModel.length > 0 &&
    !modelIds.includes(reviewVariantSourceModel)
  const hasCustomBuildVariant =
    defaultVariant.length > 0 &&
    (buildVariantSourceUnavailable || !buildVariants.includes(defaultVariant))
  const hasCustomReviewVariant =
    reviewVariant.length > 0 &&
    (reviewVariantSourceUnavailable || !reviewVariants.includes(reviewVariant))

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
    },
  })

  const confirmRemoval = () => {
    if (
      window.confirm(
        `Remove ${repository.githubOwner}/${repository.githubRepo} and its stored issues?`,
      )
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
    ? "border-blue-300 text-blue-700 hover:bg-blue-50 focus-visible:outline-blue-600"
    : "border-amber-300 text-amber-700 hover:bg-amber-50 focus-visible:outline-amber-600"
  const repositoryLabel = `${repository.githubOwner}/${repository.githubRepo}`
  const {
    collapsed: repositoryCollapsed,
    toggleCollapsed: toggleRepositoryCollapsed,
  } = useCardCollapsed(repositoryCardCollapseId(repository.id))
  const repositoryBodyId = `repository-card-body-${repository.id}`

  return (
    <article className="relative min-w-0 rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
      <div
        className={`flex items-center justify-between gap-4 ${repositoryCollapsed ? "" : "mb-[1.4rem]"}`}
      >
        <h2 className="m-0 min-w-0 truncate text-2xl tracking-[-0.025em]">
          <a
            className="text-slate-900 hover:underline"
            href={`https://github.com/${repository.githubOwner}/${repository.githubRepo}`}
          >
            {repositoryLabel}
          </a>
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
            className={`inline-flex size-8 items-center justify-center rounded-full border transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-50 ${pauseFailed ? "border-red-300 text-red-600 hover:bg-red-50 focus-visible:outline-red-600" : pauseButtonClass}`}
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
              className="inline-flex size-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              aria-label={`Actions for ${repository.githubOwner}/${repository.githubRepo}`}
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
                className="absolute top-full right-0 z-10 mt-1 min-w-40 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    setMenuOpen(false)
                    openSettings()
                  }}
                >
                  Settings
                </button>
                <hr className="my-1 border-t border-slate-200" />
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-2 text-left text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-wait disabled:opacity-50"
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
        className="m-auto w-[min(92vw,31rem)] rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/45"
        aria-labelledby={`repo-settings-title-${repository.id}`}
        onCancel={(event) => {
          if (updateSettings.isPending) event.preventDefault()
        }}
        onClose={() => setSettingsOpen(false)}
      >
        <form onSubmit={saveSettings}>
          <div className="border-b border-slate-200 px-6 py-5">
            <p className="text-xs font-extrabold tracking-[0.12em] text-blue-600 uppercase">
              Repository settings
            </p>
            <h2
              id={`repo-settings-title-${repository.id}`}
              className="mt-1 text-2xl font-bold"
            >
              {repository.githubOwner}/{repository.githubRepo}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Overrides apply to new Work Items. Empty model fields use harness
              defaults.
            </p>
          </div>
          <div className="grid gap-5 px-6 py-5">
            <label className="flex items-center gap-3 text-sm font-semibold">
              <input
                type="checkbox"
                className="size-4 rounded border-slate-300"
                checked={paused}
                onChange={(event) => setPaused(event.target.checked)}
              />
              Paused
              <span className="font-normal text-slate-500">
                Skip autonomous work selection
              </span>
            </label>
            <label className="flex items-center gap-3 text-sm font-semibold">
              <input
                type="checkbox"
                className="size-4 rounded border-slate-300"
                checked={autoMerge}
                onChange={(event) => setAutoMerge(event.target.checked)}
              />
              Auto-merge
              <span className="font-normal text-slate-500">
                Allow clanker merge when risk is low
              </span>
            </label>
            <label className="flex items-center gap-3 text-sm font-semibold">
              <input
                type="checkbox"
                className="size-4 rounded border-slate-300"
                checked={includeAllIssueAuthors}
                onChange={(event) =>
                  setIncludeAllIssueAuthors(event.target.checked)
                }
              />
              Include all Issue Authors
              <span className="font-normal text-slate-500">
                Relevant Issues from every author after Refresh
              </span>
            </label>
            {models.isPending ? (
              <p className="text-sm text-slate-500">Loading models...</p>
            ) : models.isError ? (
              <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                Models could not be loaded.
              </p>
            ) : (
              <>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Build model
                  <select
                    className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    value={defaultModel}
                    onChange={(event) => {
                      const nextModel = event.target.value
                      setDefaultModel(nextModel)
                      const sourceModel =
                        nextModel.length > 0
                          ? nextModel
                          : (config.data?.defaultModel ?? "")
                      const nextVariants = variantsForModel(
                        models.data,
                        sourceModel,
                      )
                      setDefaultVariant((current) =>
                        reconcileVariantForModel(current, nextVariants),
                      )
                      if (reviewModel.length === 0) {
                        const reviewSource =
                          nextModel.length > 0
                            ? nextModel
                            : (config.data?.reviewModel ??
                              config.data?.defaultModel ??
                              "")
                        setReviewVariant((current) =>
                          reconcileVariantForModel(
                            current,
                            variantsForModel(models.data, reviewSource),
                          ),
                        )
                      }
                    }}
                  >
                    <option value="">
                      Harness default ({harnessDefaultModel})
                    </option>
                    {hasUnavailableBuildModel && (
                      <option value={defaultModel}>{defaultModel}</option>
                    )}
                    {models.data.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                </label>
                {buildVariantSourceModel.length > 0 &&
                !buildVariantSourceUnavailable &&
                buildVariants.length === 0 ? (
                  <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                    Build thinking level override is unavailable — this model
                    has no OpenCode variants. Use harness default or pick
                    another model.
                  </p>
                ) : (
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                    Build thinking level
                    <select
                      className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      value={defaultVariant}
                      onChange={(event) =>
                        setDefaultVariant(event.target.value)
                      }
                      disabled={
                        buildVariantSourceModel.length > 0 &&
                        !buildVariantSourceUnavailable &&
                        buildVariants.length === 0
                      }
                    >
                      <option value="">
                        Harness default ({harnessDefaultVariant})
                      </option>
                      {hasCustomBuildVariant && (
                        <option value={defaultVariant}>{defaultVariant}</option>
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
                    className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    value={reviewModel}
                    onChange={(event) => {
                      const nextModel = event.target.value
                      setReviewModel(nextModel)
                      const sourceModel =
                        nextModel.length > 0
                          ? nextModel
                          : defaultModel.length > 0
                            ? defaultModel
                            : (config.data?.reviewModel ??
                              config.data?.defaultModel ??
                              "")
                      setReviewVariant((current) =>
                        reconcileVariantForModel(
                          current,
                          variantsForModel(models.data, sourceModel),
                        ),
                      )
                    }}
                  >
                    <option value="">
                      Harness default ({harnessReviewModel})
                    </option>
                    {hasUnavailableReviewModel && (
                      <option value={reviewModel}>{reviewModel}</option>
                    )}
                    {models.data.map((model) => (
                      <option key={`review-${model.id}`} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                </label>
                {reviewVariantSourceModel.length > 0 &&
                !reviewVariantSourceUnavailable &&
                reviewVariants.length === 0 ? (
                  <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                    Review thinking level override is unavailable — this model
                    has no OpenCode variants. Use harness default or pick
                    another model.
                  </p>
                ) : (
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                    Review thinking level
                    <select
                      className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      value={reviewVariant}
                      onChange={(event) => setReviewVariant(event.target.value)}
                      disabled={
                        reviewVariantSourceModel.length > 0 &&
                        !reviewVariantSourceUnavailable &&
                        reviewVariants.length === 0
                      }
                    >
                      <option value="">
                        Harness default ({harnessReviewVariant})
                      </option>
                      {hasCustomReviewVariant && (
                        <option value={reviewVariant}>{reviewVariant}</option>
                      )}
                      {reviewVariants.map((variant) => (
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
              <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                Settings could not be saved. Try again.
              </p>
            )}
          </div>
          <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4">
            <button
              type="button"
              className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-200"
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
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60"
              disabled={updateSettings.isPending}
            >
              {updateSettings.isPending ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </dialog>
      {!repositoryCollapsed && (
        <div id={repositoryBodyId}>
          <dl className="m-0 grid gap-1">
            <div className="flex min-w-0 items-baseline gap-1.5 text-[0.82rem]">
              <dt className="shrink-0 font-[750] tracking-[0.06em] text-slate-400 uppercase">
                Path:
              </dt>
              <dd
                className="m-0 min-w-0 truncate font-mono text-slate-700"
                title={repository.localPath}
              >
                {repository.localPath}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-[0.82rem]">
              <dt className="shrink-0 font-[750] tracking-[0.06em] text-slate-400 uppercase">
                Checkout:
              </dt>
              <dd className="m-0 min-w-0 truncate font-mono text-slate-700">
                {repository.isBare ? "Bare repository" : "Working tree"}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-[0.82rem]">
              <dt className="shrink-0 font-[750] tracking-[0.06em] text-slate-400 uppercase">
                Build model:
              </dt>
              <dd className="m-0 min-w-0 truncate font-mono text-slate-700">
                {repository.defaultModel ?? `Default (${harnessDefaultModel})`}
                {" · "}
                {repository.defaultVariant ??
                  `Default (${harnessDefaultVariant})`}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-[0.82rem]">
              <dt className="shrink-0 font-[750] tracking-[0.06em] text-slate-400 uppercase">
                Review model:
              </dt>
              <dd className="m-0 min-w-0 truncate font-mono text-slate-700">
                {repository.reviewModel ?? `Default (${harnessReviewModel})`}
                {" · "}
                {repository.reviewVariant ??
                  `Default (${harnessReviewVariant})`}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-[0.82rem]">
              <dt className="shrink-0 font-[750] tracking-[0.06em] text-slate-400 uppercase">
                Auto-merge:
              </dt>
              <dd className="m-0 text-slate-700">
                {repository.autoMerge ? "Enabled" : "Disabled"}
              </dd>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-[0.82rem]">
              <dt className="shrink-0 font-[750] tracking-[0.06em] text-slate-400 uppercase">
                Include all Issue Authors:
              </dt>
              <dd className="m-0 text-slate-700">
                {repository.includeAllIssueAuthors ? "Enabled" : "Disabled"}
              </dd>
            </div>
          </dl>
          {!repository.credential.configured && (
            <div className="mt-5 grid gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-950">
              <strong>GitHub token required</strong>
              {githubTokenCreated ? (
                <p className="m-0">
                  Store the generated token as{" "}
                  <code className="font-bold">
                    {repository.credential.githubTokenSecretName}
                  </code>{" "}
                  in Keymaxxer. Already-created tokens are not upgraded
                  automatically — edit the token on GitHub or recreate it, then
                  store the replacement.
                </p>
              ) : (
                <p className="m-0">
                  Create a fine-grained token, choose{" "}
                  <strong>Only select repositories</strong>, select{" "}
                  <code className="font-bold">{repository.githubRepo}</code>,
                  and allow <strong>Actions: Read and write</strong> (required
                  for workflow reruns and CI logs). Already-created tokens are
                  not upgraded automatically — edit or recreate them if Actions
                  is still read-only.
                </p>
              )}
              {githubTokenCreated ? (
                <button
                  type="button"
                  className="w-fit rounded-md bg-amber-900 px-3 py-2 font-semibold text-white transition hover:bg-amber-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-900 disabled:cursor-wait disabled:opacity-60"
                  disabled={addGitHubToken.isPending}
                  onClick={() => addGitHubToken.mutate()}
                >
                  {addGitHubToken.isPending
                    ? "Waiting for Keymaxxer"
                    : "Store in Keymaxxer"}
                </button>
              ) : (
                <a
                  className="w-fit rounded-md bg-amber-900 px-3 py-2 font-semibold text-white no-underline transition hover:bg-amber-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-900"
                  href={repository.credential.githubTokenCreationUrl}
                  onClick={() => setGithubTokenCreated(true)}
                  rel="noreferrer"
                  target="_blank"
                >
                  Create GitHub token
                </a>
              )}
              {addGitHubToken.isError && (
                <p className="m-0 text-red-700" role="alert">
                  Keymaxxer setup was cancelled or failed.
                </p>
              )}
            </div>
          )}
          <div className="mt-5 border-t border-slate-100 pt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="m-0 text-[0.68rem] font-[750] tracking-[0.08em] text-slate-400 uppercase">
                Relevant issues
              </h3>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-wait disabled:opacity-60"
                disabled={refreshingIssues || !repository.credential.configured}
                onClick={() => refreshIssues.mutate()}
                aria-label={
                  refreshingIssues ? "Refreshing issues" : "Refresh issues"
                }
                title={
                  repository.credential.configured
                    ? "Refresh issues"
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
              <p className="mb-2 text-sm text-red-700" role="alert">
                Failed to refresh issues.
              </p>
            )}
            {repository.issuesReconciledAt === null ? (
              <p className="m-0 text-sm text-slate-500">Not refreshed yet.</p>
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
            <p className="mt-3 mb-0 text-sm text-red-700" role="alert">
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
      <p className="m-0 text-sm text-slate-500">
        No issues found this harness can work on.
      </p>
    )
  }

  const childrenByParent = new Map<number, RepositoryIssue[]>()
  for (const issue of issues) {
    if (issue.parent === null) continue
    const children = childrenByParent.get(issue.parent.githubIssueNumber) ?? []
    children.push(issue)
    childrenByParent.set(issue.parent.githubIssueNumber, children)
  }

  return (
    <ul className="m-0 grid list-none gap-2 p-0">
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

        const children = childrenByParent.get(issue.githubIssueNumber) ?? []
        const closedChildren = children.filter(
          (child) => child.state === "CLOSED",
        ).length
        return (
          <li className="min-w-0" key={issue.id}>
            <details
              className="group -mx-2.5 rounded-lg bg-slate-50/90 px-2.5 py-1"
              open
            >
              <summary className="grid cursor-pointer list-none grid-cols-[2.25rem_minmax(0,1fr)_auto] items-start gap-2 py-1.5 marker:content-none">
                <span className="font-mono text-xs leading-5 font-semibold text-blue-600">
                  #{issue.githubIssueNumber}
                </span>
                <span className="min-w-0">
                  <a
                    className="font-semibold text-slate-800 hover:text-blue-700 hover:underline"
                    href={issue.url}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {issue.title}
                  </a>
                  {issue.issueAuthor !== null && issue.issueAuthor !== "" && (
                    <span className="mt-0.5 block text-xs font-normal text-slate-500">
                      {issue.issueAuthor}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-[0.65rem] font-bold tracking-wide text-slate-500 uppercase">
                  {closedChildren}/{children.length} closed
                  <svg
                    aria-hidden="true"
                    className="size-3.5 transition-transform group-open:rotate-180"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </span>
              </summary>
              <ul className="relative m-0 grid list-none gap-1.5 py-1 pl-0 before:absolute before:top-0 before:bottom-1 before:-left-2.5 before:w-0.5 before:rounded-full before:bg-blue-200">
                {children.map((child) => (
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
      })}
    </ul>
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
  const isActionable = issue.state === "OPEN" && issue.blockedBy.length === 0
  const [menuOpen, setMenuOpen] = useState(false)
  const queryClient = useQueryClient()
  const query = workItemsQuery(issue.repositoryId)
  const issueWorkItems = workItems.filter(
    (workItem) => workItem.githubIssueNumber === issue.githubIssueNumber,
  )
  const latestWorkItem = issueWorkItems.at(-1)
  const hasUnfinishedWorkItem =
    latestWorkItem !== undefined &&
    (!latestWorkItem.isTerminal || latestWorkItem.canRetry)
  const canImplement =
    isActionable && !workItemsLoading && !hasUnfinishedWorkItem
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
            githubIssueNumber: issue.githubIssueNumber,
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
            githubIssueNumber: issue.githubIssueNumber,
          },
          ...workItemFields,
        },
      })
      return result.implementLocally
    },
    onSuccess: onImplementSuccess,
  })
  const implementPending = implementNow.isPending || implementLocally.isPending

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
      className={`min-w-0 rounded-md text-sm ${issue.blockedBy.length > 0 ? "bg-amber-50/70 py-2" : "py-0.5"}`}
    >
      <div className="grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)_auto] items-start gap-2">
        <span className="font-mono text-xs leading-5 text-slate-400">
          #{issue.githubIssueNumber}
        </span>
        <span className="min-w-0">
          <a
            className="text-slate-700 hover:text-blue-700 hover:underline"
            href={issue.url}
          >
            {issue.title}
          </a>
          {issue.issueAuthor !== null && issue.issueAuthor !== "" && (
            <span className="mt-0.5 block text-xs text-slate-500">
              {issue.issueAuthor}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {issue.state === "CLOSED" && (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[0.6rem] font-bold tracking-wide text-slate-500 uppercase">
              Closed
            </span>
          )}
          {issue.blockedBy.length > 0 && (
            <span className="rounded-full bg-amber-200/70 px-1.5 py-0.5 text-[0.6rem] font-bold tracking-wide text-amber-900 uppercase">
              Blocked
            </span>
          )}
          {canImplement && (
            <span className="relative" data-issue-menu={issue.id}>
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                aria-label={`Actions for issue #${issue.githubIssueNumber}`}
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
                  className="absolute top-full right-0 z-10 mt-1 min-w-44 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
                    disabled={implementPending}
                    onClick={() => {
                      setMenuOpen(false)
                      implementLocally.reset()
                      implementNow.mutate()
                    }}
                  >
                    {implementNow.isPending ? "Starting..." : "Implement now"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
                    disabled={implementPending}
                    onClick={() => {
                      setMenuOpen(false)
                      implementNow.reset()
                      implementLocally.mutate()
                    }}
                  >
                    {implementLocally.isPending
                      ? "Starting..."
                      : "Implement locally"}
                  </button>
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
                  repository.githubOwner,
                  repository.githubRepo,
                  latestWorkItem.githubIssueNumber,
                )
          }
          pullRequestUrl={workItemPullRequestUrl(
            repository.githubOwner,
            repository.githubRepo,
            latestWorkItem.githubPullRequestNumber,
          )}
        />
      )}
      {(implementNow.isError || implementLocally.isError) && (
        <p className="mt-1.5 mb-0 pl-11 text-xs text-red-700" role="alert">
          Could not start implementation. Refresh the issues and try again.
        </p>
      )}
      {issue.blockedBy.length > 0 && (
        <p className="mt-1.5 mb-0 pl-11 text-xs text-amber-900">
          Blocked by{" "}
          {issue.blockedBy.map((blocker, index) => (
            <span key={blocker.githubIssueUrl}>
              {index > 0 && ", "}
              <a
                className="font-mono font-semibold underline decoration-amber-400 underline-offset-2 hover:text-blue-700"
                href={blocker.githubIssueUrl}
              >
                #{blocker.githubIssueNumber}
              </a>
            </span>
          ))}
        </p>
      )}
    </li>
  )
}

type JobsTab = "working" | "failed" | "completed"

const JOBS_TABS = [
  { id: "working", label: "Working" },
  { id: "failed", label: "Failed" },
  { id: "completed", label: "Completed" },
] as const satisfies readonly { id: JobsTab; label: string }[]

const jobsTabEmptyMessage = (tab: JobsTab): string => {
  if (tab === "working") return "No working jobs."
  if (tab === "failed") return "No failed jobs."
  return "No completed jobs."
}

const jobsTabListAriaLabel = (tab: JobsTab): string => {
  if (tab === "working") return "Working jobs"
  if (tab === "failed") return "Failed jobs"
  return "Completed jobs"
}

function JobsCard() {
  const [selectedTab, setSelectedTab] = useState<JobsTab>("working")
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

  const repositoryById = new Map(
    repositories.map((repository) => [repository.id, repository] as const),
  )
  const issueByRepoAndNumber = new Map<string, { title: string; url: string }>()
  for (const query of issueQueries) {
    for (const issue of query.data ?? []) {
      issueByRepoAndNumber.set(
        `${issue.repositoryId}:${issue.githubIssueNumber}`,
        { title: issue.title, url: issue.url },
      )
    }
  }
  const sortNewestFirst = (items: readonly WorkItem[]) =>
    items
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const workingItems = sortNewestFirst(
    workingQueries.flatMap((query) => query.data ?? []),
  )
  const failedItems = sortNewestFirst(
    failedQueries.flatMap((query) => query.data ?? []),
  ).slice(0, JOBS_FAILED_LIMIT)
  const completedItems = sortNewestFirst(
    completedQueries.flatMap((query) => query.data ?? []),
  ).slice(0, JOBS_COMPLETED_LIMIT)
  const activeItems =
    selectedTab === "working"
      ? workingItems
      : selectedTab === "failed"
        ? failedItems
        : completedItems
  const activeQueries =
    selectedTab === "working"
      ? workingQueries
      : selectedTab === "failed"
        ? failedQueries
        : completedQueries
  const loading = activeQueries.some((query) => query.isLoading)
  const failed = activeQueries.some((query) => query.isError)
  const emptyMessage = jobsTabEmptyMessage(selectedTab)
  const listAriaLabel = jobsTabListAriaLabel(selectedTab)

  if (repositories.length === 0) {
    return (
      <article className="rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
        <p className="m-0 text-sm text-slate-500">
          Add a repository to see jobs.
        </p>
      </article>
    )
  }

  if (loading && activeItems.length === 0) {
    return <JobsCardSkeleton />
  }

  if (failed) {
    return (
      <article className="rounded-[0.9rem] border border-red-200 bg-red-50 p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
        <p className="m-0 text-sm text-red-700" role="alert">
          Could not load jobs. Please try again.
        </p>
      </article>
    )
  }

  return (
    <article className="rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
      <div
        className="mb-3 flex gap-1 border-b border-slate-200"
        role="tablist"
        aria-label="Jobs"
      >
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
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-semibold transition ${
                selected
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
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
              {tab.id === "working" && ` (${workingItems.length})`}
              {tab.id === "failed" && ` (${failedItems.length})`}
            </button>
          )
        })}
      </div>
      <div
        role="tabpanel"
        id={`jobs-panel-${selectedTab}`}
        aria-labelledby={`jobs-tab-${selectedTab}`}
      >
        {activeItems.length === 0 ? (
          <p className="m-0 text-sm text-slate-500">{emptyMessage}</p>
        ) : (
          <ul
            className="m-0 grid list-none gap-2 p-0"
            aria-label={listAriaLabel}
          >
            {activeItems.map((workItem) => {
              const repository = repositoryById.get(workItem.repositoryId)
              const repositoryLabel =
                repository === undefined
                  ? workItem.repositoryId
                  : `${repository.githubOwner}/${repository.githubRepo}`
              const issue = issueByRepoAndNumber.get(
                `${workItem.repositoryId}:${workItem.githubIssueNumber}`,
              )
              const issueTitle =
                issue?.title ?? workItem.issueTitle ?? undefined
              const issueUrl =
                issue?.url !== undefined && issue.url !== ""
                  ? issue.url
                  : repository === undefined
                    ? null
                    : workItemIssueUrl(
                        repository.githubOwner,
                        repository.githubRepo,
                        workItem.githubIssueNumber,
                      )
              const issueIdentity =
                issueTitle === undefined
                  ? `#${workItem.githubIssueNumber}`
                  : `#${workItem.githubIssueNumber} · ${issueTitle}`
              const issueIdentityContent = (
                <>
                  <span className="font-mono">
                    #{workItem.githubIssueNumber}
                  </span>
                  {issueTitle !== undefined && (
                    <span className="font-sans"> · {issueTitle}</span>
                  )}
                </>
              )
              const { sessionId, worktreePath } = sessionWorktreeParts(
                workItem.sessionId,
                workItem.worktreePath,
              )
              return (
                <li
                  className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2"
                  key={workItem.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="m-0 truncate text-xs font-semibold text-slate-700">
                        {repositoryLabel}
                      </p>
                      {issueUrl !== null && issueUrl !== "" ? (
                        <a
                          className="m-0 block truncate text-xs font-semibold text-blue-600 hover:underline"
                          href={issueUrl}
                          title={issueIdentity}
                        >
                          {issueIdentityContent}
                        </a>
                      ) : (
                        <p
                          className="m-0 truncate text-xs font-semibold text-blue-600"
                          title={issueIdentity}
                        >
                          {issueIdentityContent}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="text-[0.65rem] font-bold tracking-wide text-slate-600 uppercase">
                        {workItem.stateLabel}
                      </span>
                      <WorkItemPauseButton workItem={workItem} />
                    </div>
                  </div>
                  {(sessionId !== null || worktreePath !== null) && (
                    <p className="mt-1 mb-0 flex min-w-0 flex-wrap items-center gap-1">
                      {sessionId !== null && (
                        <Copy
                          value={sessionId}
                          className="min-w-0 max-w-full"
                          textClassName="font-mono text-[0.7rem] text-slate-500"
                        />
                      )}
                      {sessionId !== null && worktreePath !== null && (
                        <span className="shrink-0 font-mono text-[0.7rem] text-slate-500">
                          -
                        </span>
                      )}
                      {worktreePath !== null && (
                        <Copy
                          value={worktreePath}
                          className="min-w-0 max-w-full"
                          textClassName="font-mono text-[0.7rem] text-slate-500"
                        />
                      )}
                    </p>
                  )}
                  <WorkItemLifecycleStatus
                    workItem={workItem}
                    compact
                    issueUrl={issueUrl}
                    pullRequestUrl={
                      repository === undefined
                        ? null
                        : workItemPullRequestUrl(
                            repository.githubOwner,
                            repository.githubRepo,
                            workItem.githubPullRequestNumber,
                          )
                    }
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </article>
  )
}

function JobsCardSkeleton() {
  return (
    <article
      className="rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]"
      role="status"
      aria-label="Loading jobs"
      aria-busy="true"
    >
      <div className="grid gap-2">
        <span className="block h-12 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none" />
        <span className="block h-12 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none" />
      </div>
    </article>
  )
}

function WorkItemPauseButton({ workItem }: { workItem: WorkItem }) {
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

  if (workItem.isTerminal) {
    return null
  }

  const pending = pause.isPending || start.isPending
  const failed = pause.isError || start.isError
  const label = workItem.paused ? "Start job" : "Pause job"
  const buttonClass = workItem.paused
    ? "border-blue-300 text-blue-700 hover:bg-blue-50 focus-visible:outline-blue-600"
    : "border-amber-300 text-amber-700 hover:bg-amber-50 focus-visible:outline-amber-600"

  return (
    <button
      type="button"
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full border transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-50 ${failed ? "border-red-300 text-red-600 hover:bg-red-50 focus-visible:outline-red-600" : buttonClass}`}
      disabled={pending}
      onClick={() => (workItem.paused ? start.mutate() : pause.mutate())}
      aria-label={pending ? `${label} in progress` : label}
      title={failed ? `Could not ${label.toLowerCase()}. Try again.` : label}
    >
      {pending ? (
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
      ) : workItem.paused ? (
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
  )
}

function WorkItemLifecycleStatus({
  workItem,
  compact = false,
  pullRequestUrl = null,
  issueUrl = null,
}: {
  workItem: WorkItem
  compact?: boolean
  pullRequestUrl?: string | null
  issueUrl?: string | null
}) {
  const queryClient = useQueryClient()
  const status = workItem.status
  const canRetry = compact && workItem.canRetry
  const retriesStatusChecks =
    workItem.failureCode === "pr_status_checks_unresolved" ||
    workItem.state === "WATCH_PR_STATUS_CHECKS" ||
    workItem.state === "INVESTIGATE_PR_STATUS_CHECKS" ||
    (workItem.canRetry &&
      workItem.lifecycleLabels.at(-1)?.phase === "GITHUB_STATUS_CHECKS")
  const canReset = compact
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
  const prNumber = workItem.githubPullRequestNumber
  const statusBadgeClassName = `rounded-full px-2 py-0.5 text-[0.6rem] font-bold tracking-wide uppercase ${
    status === "FAILED" || status === "INTERRUPTED"
      ? "bg-red-100 text-red-700"
      : status === "COMPLETE" || status === "SUCCEEDED"
        ? "bg-green-100 text-green-700"
        : status === "ABANDONED" || status === "CANCELLED"
          ? "bg-slate-200 text-slate-600"
          : status === "NEEDS_HUMAN" || status === "NEEDS_HUMAN_REVIEW"
            ? "bg-amber-100 text-amber-800"
            : status === "WAITING_FOR_WORKER_SLOT"
              ? "bg-violet-100 text-violet-800"
              : "bg-blue-100 text-blue-700"
  }`
  const openPullRequestLabel =
    prNumber === null ? null : `Open pull request #${prNumber}`
  const isNoChangeComplete =
    workItem.state === "COMPLETE" &&
    prNumber === null &&
    workItem.completionSummary !== null &&
    workItem.completionSummary.trim() !== ""

  return (
    <div
      className={
        compact
          ? "mt-2"
          : "mt-2 ml-11 rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-normal text-slate-500">
          {formatStartedAgo(workItem.createdAt, nowMs)}
        </span>
        <WorkItemOutcomePresentation
          state={workItem.state}
          statusLabel={workItem.statusLabel}
          statusBadgeClassName={statusBadgeClassName}
          githubPullRequestNumber={workItem.githubPullRequestNumber}
          pullRequestUrl={pullRequestUrl}
          completionSummary={workItem.completionSummary}
          issueUrl={issueUrl}
        />
      </div>
      {workItem.lifecycleLabels.length > 0 && (
        <ol
          className="mt-2 mb-0 flex list-none flex-wrap gap-1 p-0"
          aria-label="Lifecycle steps"
        >
          {workItem.lifecycleLabels.map((lifecycleLabel) => {
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
            const chipClassName =
              "rounded bg-white px-1.5 py-1 text-[0.65rem] text-slate-600 ring-1 ring-slate-200"
            const duration = displayDurationMs !== null && (
              <span className="ml-1 text-slate-400">
                {formatDuration(displayDurationMs)}
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
                  >
                    {lifecycleLabel.label}
                    {duration}
                  </a>
                ) : (
                  <span className={chipClassName}>
                    {lifecycleLabel.label}
                    {duration}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {workItem.statusMessage !== null && (
        <p
          className={`mt-1.5 mb-0 text-xs ${
            status === "WAITING_FOR_WORKER_SLOT"
              ? "text-violet-800"
              : "text-red-700"
          }`}
        >
          {workItem.statusMessage}
        </p>
      )}
      {(canReset || canRetry) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {canReset && (
            <button
              type="button"
              className="inline-flex size-7 items-center justify-center rounded-md text-red-600 transition hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-wait disabled:opacity-60"
              disabled={actionsPending}
              onClick={() => reset.mutate()}
              aria-label={reset.isPending ? "Resetting job" : "Reset job"}
              title={reset.isPending ? "Resetting..." : "Reset"}
            >
              {reset.isPending ? (
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
              ) : (
                <svg
                  aria-hidden="true"
                  className="size-4"
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
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:border-blue-300 hover:text-blue-700 disabled:cursor-wait disabled:opacity-60"
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
        <p className="mt-1.5 mb-0 text-xs text-red-700" role="alert">
          Could not reset this job.
        </p>
      )}
      {retry.isError && (
        <p className="mt-1.5 mb-0 text-xs text-red-700" role="alert">
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
      <span className="block h-4 w-[85%] animate-pulse rounded bg-[#e8edf4] motion-reduce:animate-none" />
      <span className="block h-4 w-[65%] animate-pulse rounded bg-[#e8edf4] motion-reduce:animate-none" />
    </div>
  )
}

function RepositoryCardsSkeleton() {
  return (
    <section
      className="grid grid-cols-1 gap-4 md:grid-cols-2"
      aria-label="Loading repositories"
      aria-busy="true"
    >
      {[0, 1].map((item) => (
        <div
          className="grid min-w-0 gap-4 rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]"
          key={item}
        >
          <span className="block h-[0.85rem] w-[35%] animate-pulse rounded-[0.3rem] bg-[#e8edf4] motion-reduce:animate-none" />
          <span className="block h-[1.6rem] w-[65%] animate-pulse rounded-[0.3rem] bg-[#e8edf4] motion-reduce:animate-none" />
          <span className="block h-[0.85rem] w-[90%] animate-pulse rounded-[0.3rem] bg-[#e8edf4] motion-reduce:animate-none" />
        </div>
      ))}
    </section>
  )
}
