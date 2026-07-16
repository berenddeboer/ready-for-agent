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
import { followRepositoryIssuesLive } from "../refresh-issues-live.js"
import { streamRepositoryChanges } from "../repository-live.js"

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

const modelsQuery = {
  queryKey: ["models"],
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  queryFn: async () => {
    const result = await graphql.query({ models: true })
    return result.models
  },
}

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

type WorkItem = {
  id: string
  repositoryId: string
  githubIssueNumber: number
  state: WorkItemState
  stateLabel: string
  status: WorkItemStatus
  statusLabel: string
  statusMessage: string | null
  paused: boolean
  canRetry: boolean
  isTerminal: boolean
  sessionId: string | null
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
  state: true,
  stateLabel: true,
  status: true,
  statusLabel: true,
  statusMessage: true,
  paused: true,
  canRetry: true,
  isTerminal: true,
  sessionId: true,
  createdAt: true,
  lifecycleLabels: {
    phase: true,
    label: true,
    status: true,
    durationMs: true,
  },
} as const

/** Formats a duration for step labels, e.g. "3s" or "4m 15s". */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
}

/** Formats job start time as a relative phrase, e.g. "15 min ago". */
function formatStartedAgo(iso: string, nowMs = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - new Date(iso).getTime())
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? "1 day ago" : `${days} days ago`
}

const workItemsQuery = (repositoryId: string) => ({
  queryKey: ["work-items", repositoryId],
  queryFn: async (): Promise<readonly WorkItem[]> => {
    const result = await graphql.query({
      workItems: {
        __args: { repositoryId },
        ...workItemFields,
      },
    })
    return result.workItems
  },
})

export const Route = createFileRoute("/")({
  component: HomePage,
})

function HomePage() {
  return (
    <main>
      <header className="my-8 sm:my-14">
        <p className="text-xs font-extrabold tracking-[0.12em] text-blue-600 uppercase">
          Workspace
        </p>
        <h1 className="mt-0.5 mb-2 text-[clamp(2rem,5vw,3.5rem)] leading-[1.05] font-bold tracking-[-0.045em]">
          Configured repositories
        </h1>
        <p className="text-slate-500">
          Local GitHub repositories available to Ready for Agent.
        </p>
      </header>
      <Suspense fallback={<RepositoryCardsSkeleton />}>
        <RepositoryCards />
      </Suspense>
      <section className="mt-8" aria-label="Jobs">
        <h2 className="mb-4 text-lg font-bold tracking-[-0.02em] text-slate-900">
          Jobs
        </h2>
        <Suspense fallback={<JobsCardSkeleton />}>
          <JobsCard />
        </Suspense>
      </section>
    </main>
  )
}

function RepositoryCards() {
  const queryClient = useQueryClient()
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)
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
            Add a local Git repository with the CLI:
          </p>
          <code className="mt-3 inline-block rounded-md bg-slate-100 px-3 py-2 font-mono text-sm text-slate-800">
            bun run harness-cli add /path/to/local/repo
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
    })
  }

  const standardVariants = ["low", "medium", "high", "max"]
  const harnessDefaultModel = config.data?.defaultModel ?? "harness default"
  const harnessDefaultVariant = config.data?.defaultVariant ?? "harness default"
  const resolvedBuildModel = repository.defaultModel ?? harnessDefaultModel
  const resolvedBuildVariant =
    repository.defaultVariant ?? harnessDefaultVariant
  const harnessReviewModel =
    config.data?.reviewModel ?? `Build (${resolvedBuildModel})`
  const harnessReviewVariant =
    config.data?.reviewVariant ?? `Build (${resolvedBuildVariant})`
  const hasUnavailableBuildModel =
    defaultModel.length > 0 && !models.data?.includes(defaultModel)
  const hasUnavailableReviewModel =
    reviewModel.length > 0 && !models.data?.includes(reviewModel)
  const hasCustomBuildVariant =
    defaultVariant.length > 0 && !standardVariants.includes(defaultVariant)
  const hasCustomReviewVariant =
    reviewVariant.length > 0 && !standardVariants.includes(reviewVariant)

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

  return (
    <article className="relative min-w-0 rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
      <div className="mb-[1.4rem] flex items-center justify-between gap-4">
        <h2 className="m-0 min-w-0 truncate text-2xl tracking-[-0.025em]">
          <a
            className="text-slate-900 hover:underline"
            href={`https://github.com/${repository.githubOwner}/${repository.githubRepo}`}
          >
            {repository.githubOwner}/{repository.githubRepo}
          </a>
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {repository.paused && (
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-md text-amber-700 hover:bg-amber-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
              aria-label="Paused"
              title="Paused"
            >
              <svg
                aria-hidden="true"
                className="size-4"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            </button>
          )}
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
      <dl className="m-0 grid gap-[0.8rem]">
        <div className="min-w-0">
          <dt className="text-[0.68rem] font-[750] tracking-[0.08em] text-slate-400 uppercase">
            Local path
          </dt>
          <dd
            className="mt-[0.15rem] truncate font-mono text-[0.82rem] text-slate-700"
            title={repository.localPath}
          >
            {repository.localPath}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[0.68rem] font-[750] tracking-[0.08em] text-slate-400 uppercase">
            Checkout
          </dt>
          <dd className="mt-[0.15rem] truncate font-mono text-[0.82rem] text-slate-700">
            {repository.isBare ? "Bare repository" : "Working tree"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[0.68rem] font-[750] tracking-[0.08em] text-slate-400 uppercase">
            Build model
          </dt>
          <dd className="mt-[0.15rem] truncate font-mono text-[0.82rem] text-slate-700">
            {repository.defaultModel ?? `Default (${harnessDefaultModel})`}
            {" · "}
            {repository.defaultVariant ?? `Default (${harnessDefaultVariant})`}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[0.68rem] font-[750] tracking-[0.08em] text-slate-400 uppercase">
            Review model
          </dt>
          <dd className="mt-[0.15rem] truncate font-mono text-[0.82rem] text-slate-700">
            {repository.reviewModel ?? `Default (${harnessReviewModel})`}
            {" · "}
            {repository.reviewVariant ?? `Default (${harnessReviewVariant})`}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[0.68rem] font-[750] tracking-[0.08em] text-slate-400 uppercase">
            Auto-merge
          </dt>
          <dd className="mt-[0.15rem] text-[0.82rem] text-slate-700">
            {repository.autoMerge ? "Enabled" : "Disabled"}
          </dd>
        </div>
      </dl>
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
                    onChange={(event) => setDefaultModel(event.target.value)}
                  >
                    <option value="">
                      Harness default ({harnessDefaultModel})
                    </option>
                    {hasUnavailableBuildModel && (
                      <option value={defaultModel}>{defaultModel}</option>
                    )}
                    {models.data.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Build thinking level
                  <select
                    className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    value={defaultVariant}
                    onChange={(event) => setDefaultVariant(event.target.value)}
                  >
                    <option value="">
                      Harness default ({harnessDefaultVariant})
                    </option>
                    {hasCustomBuildVariant && (
                      <option value={defaultVariant}>{defaultVariant}</option>
                    )}
                    {standardVariants.map((variant) => (
                      <option key={variant} value={variant}>
                        {variant[0]?.toUpperCase()}
                        {variant.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Review model
                  <select
                    className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    value={reviewModel}
                    onChange={(event) => setReviewModel(event.target.value)}
                  >
                    <option value="">
                      Harness default ({harnessReviewModel})
                    </option>
                    {hasUnavailableReviewModel && (
                      <option value={reviewModel}>{reviewModel}</option>
                    )}
                    {models.data.map((model) => (
                      <option key={`review-${model}`} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Review thinking level
                  <select
                    className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    value={reviewVariant}
                    onChange={(event) => setReviewVariant(event.target.value)}
                  >
                    <option value="">
                      Harness default ({harnessReviewVariant})
                    </option>
                    {hasCustomReviewVariant && (
                      <option value={reviewVariant}>{reviewVariant}</option>
                    )}
                    {standardVariants.map((variant) => (
                      <option key={`review-${variant}`} value={variant}>
                        {variant[0]?.toUpperCase()}
                        {variant.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
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
      {!repository.credential.configured && (
        <div className="mt-5 grid gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm text-amber-950">
          <strong>GitHub token required</strong>
          {githubTokenCreated ? (
            <p className="m-0">
              Store the generated token as{" "}
              <code className="font-bold">
                {repository.credential.githubTokenSecretName}
              </code>{" "}
              in Keymaxxer.
            </p>
          ) : (
            <p className="m-0">
              Create a fine-grained token, choose{" "}
              <strong>Only select repositories</strong>, and select{" "}
              <code className="font-bold">{repository.githubRepo}</code>.
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
              repositoryId={repository.id}
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
    </article>
  )
}

function RepositoryIssues({
  repositoryId,
  workItems,
  workItemsLoading,
}: {
  repositoryId: string
  workItems: readonly WorkItem[]
  workItemsLoading: boolean
}) {
  const { data: issues } = useSuspenseQuery(issuesQuery(repositoryId))

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
                <a
                  className="min-w-0 font-semibold text-slate-800 hover:text-blue-700 hover:underline"
                  href={issue.url}
                  onClick={(event) => event.stopPropagation()}
                >
                  {issue.title}
                </a>
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
  workItems,
  workItemsLoading,
}: {
  issue: RepositoryIssue
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
    latestWorkItem !== undefined && !latestWorkItem.isTerminal
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
        <a
          className="min-w-0 text-slate-700 hover:text-blue-700 hover:underline"
          href={issue.url}
        >
          {issue.title}
        </a>
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
        <WorkItemLifecycleStatus workItem={latestWorkItem} />
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

function JobsCard() {
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)
  const workItemQueries = useQueries({
    queries: repositories.map((repository) => ({
      ...workItemsQuery(repository.id),
      refetchInterval: ({ state }: { state: { data: unknown } }) => {
        const items = state.data as readonly WorkItem[] | undefined
        return items?.some(
          (item) => item.status === "QUEUED" || item.status === "RUNNING",
        )
          ? 1_000
          : false
      },
    })),
  })

  const repositoryById = new Map(
    repositories.map((repository) => [repository.id, repository] as const),
  )
  const workItems = workItemQueries
    .flatMap((query) => query.data ?? [])
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const loading = workItemQueries.some((query) => query.isLoading)
  const failed = workItemQueries.some((query) => query.isError)

  if (repositories.length === 0) {
    return (
      <article className="rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
        <p className="m-0 text-sm text-slate-500">
          Add a repository to see jobs.
        </p>
      </article>
    )
  }

  if (loading && workItems.length === 0) {
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

  if (workItems.length === 0) {
    return (
      <article className="rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
        <p className="m-0 text-sm text-slate-500">No jobs yet.</p>
      </article>
    )
  }

  return (
    <article className="rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
      <ul className="m-0 grid list-none gap-2 p-0" aria-label="All jobs">
        {workItems.map((workItem) => {
          const repository = repositoryById.get(workItem.repositoryId)
          const repositoryLabel =
            repository === undefined
              ? workItem.repositoryId
              : `${repository.githubOwner}/${repository.githubRepo}`
          return (
            <li
              className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2"
              key={workItem.id}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="m-0 truncate text-xs font-semibold text-slate-700">
                    {repositoryLabel}
                  </p>
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-xs font-semibold text-blue-600">
                      Issue #{workItem.githubIssueNumber}
                    </span>
                    <WorkItemPauseButton workItem={workItem} />
                  </div>
                </div>
                <span className="shrink-0 text-[0.65rem] font-bold tracking-wide text-slate-600 uppercase">
                  {workItem.stateLabel}
                </span>
              </div>
              {workItem.sessionId !== null && workItem.sessionId !== "" && (
                <p
                  className="mt-1 mb-0 truncate font-mono text-[0.7rem] text-slate-500"
                  title={workItem.sessionId}
                >
                  Session {workItem.sessionId}
                </p>
              )}
              <WorkItemLifecycleStatus workItem={workItem} compact />
            </li>
          )
        })}
      </ul>
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
    queryClient.setQueryData<readonly WorkItem[]>(
      workItemsQuery(workItem.repositoryId).queryKey,
      (current) =>
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
    ? "text-blue-700 hover:bg-blue-50 focus-visible:outline-blue-600"
    : "text-amber-700 hover:bg-amber-50 focus-visible:outline-amber-600"

  return (
    <button
      type="button"
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-50 ${failed ? "text-red-600 hover:bg-red-50 focus-visible:outline-red-600" : buttonClass}`}
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
}: {
  workItem: WorkItem
  compact?: boolean
}) {
  const queryClient = useQueryClient()
  const status = workItem.status
  const canRetry = compact && workItem.canRetry
  const canReset = compact
  const patchWorkItem = (updated: WorkItem) => {
    queryClient.setQueryData<readonly WorkItem[]>(
      workItemsQuery(workItem.repositoryId).queryKey,
      (current) =>
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
      queryClient.setQueryData<readonly WorkItem[]>(
        workItemsQuery(workItem.repositoryId).queryKey,
        (current) => current?.filter((candidate) => candidate.id !== deletedId),
      )
    },
  })
  const actionsPending = retry.isPending || reset.isPending

  return (
    <div
      className={
        compact
          ? "mt-2"
          : "mt-2 ml-11 rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-700">
          {workItem.stateLabel}
          <span className="ml-1.5 font-normal text-slate-500">
            {formatStartedAgo(workItem.createdAt)}
          </span>
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[0.6rem] font-bold tracking-wide uppercase ${
            status === "FAILED" || status === "INTERRUPTED"
              ? "bg-red-100 text-red-700"
              : status === "COMPLETE" || status === "SUCCEEDED"
                ? "bg-green-100 text-green-700"
                : status === "ABANDONED" || status === "CANCELLED"
                  ? "bg-slate-200 text-slate-600"
                  : status === "NEEDS_HUMAN"
                    ? "bg-amber-100 text-amber-800"
                    : "bg-blue-100 text-blue-700"
          }`}
        >
          {workItem.statusLabel}
        </span>
      </div>
      {workItem.lifecycleLabels.length > 0 && (
        <ol
          className="mt-2 mb-0 flex list-none flex-wrap gap-1 p-0"
          aria-label="Lifecycle steps"
        >
          {workItem.lifecycleLabels.map((lifecycleLabel) => (
            <li
              className="rounded bg-white px-1.5 py-1 text-[0.65rem] text-slate-600 ring-1 ring-slate-200"
              key={lifecycleLabel.phase}
            >
              {lifecycleLabel.label}
              {lifecycleLabel.durationMs !== null && (
                <span className="ml-1 text-slate-400">
                  {formatDuration(lifecycleLabel.durationMs)}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {workItem.statusMessage !== null && (
        <p className="mt-1.5 mb-0 text-xs text-red-700">
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
              {retry.isPending ? "Retrying..." : "Retry"}
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
          Could not retry this job.
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
