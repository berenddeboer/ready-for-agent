import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  useBlocker,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import {
  type CSSProperties,
  type FormEvent,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { createClient } from "@ready-for-agent/graphql-client"
import { COMPLETED_WORK_ITEMS_DEFAULT_PAGE_SIZE as completedWorkItemsDefaultPageSize } from "@ready-for-agent/work-item-lifecycle/jobs-completed-window"
import { formatAgentBackendStatusLabel } from "./agent-backend-status-label.js"
import { AgentBackendWarnings } from "./agent-backend-warnings.js"
import { AgentModelSelect } from "./agent-model-select.js"
import {
  type AgentModelOption,
  CLAUDE_AGENT_BACKEND_ID,
  agentModelCatalogNotice,
  agentModelSaveBlockReason,
  blocksAgentModelSave,
  formatUnavailableVariantLabel,
  formatVariantLabel,
  isClaudeBedrockConfigurationMode,
  isUnavailableCatalogModel,
  reconcileVariantForModel,
  thinkingLevelsForModel,
} from "./agent-model-settings.js"
import { Banner } from "./banner.js"
import { repositoryCardCollapseId, useCardCollapsed } from "./card-collapse.js"
import { CardCollapseToggle } from "./card-collapse-toggle.js"
import { Copy } from "./copy.js"
import { forgeChangeRequestShort } from "./forge-change-request.js"
import {
  type GraphqlWorkItemState,
  issueActionEligibility,
} from "./issue-action-eligibility.js"
import {
  formatLastRefreshedAgo,
  isIssueProjectionStale,
} from "./issue-projection-freshness.js"
import {
  formatDuration,
  formatStartedAgo,
  isLiveDurationStatus,
  liveDurationMs,
  useNowMs,
} from "./live-duration.js"
import {
  ParentIssueActionsMenu,
  isParentImplementAllWithAutoMergeEligible,
} from "./parent-issue-actions-menu.js"
import {
  type LifecycleLabelChip,
  type LifecyclePipelineLaneId,
  type PipelineLaneId,
  lifecycleFocusLaneFor,
  lifecycleLaneForPhase,
  pipelineLaneIdFromServerLaneId,
  planLifecycleChipPresentation,
} from "./pipeline-lanes.js"
import {
  AddRepositoryGuidance,
  EmptyRepositoriesBlankSlate,
  addRepositoryCommandQuery,
} from "./pipeline-page.js"
import { followRepositoryIssuesLive } from "./refresh-issues-live.js"
import {
  followOpenPullRequestCountLive,
  openPullRequestCountPresentation,
  openPullRequestCountsQueryKey,
} from "./refresh-open-pull-request-count-live.js"
import {
  followRepositoryMembershipLive,
  liveUpdatesWarningPresentation,
} from "./refresh-repositories-live.js"
import {
  completedWorkItemsHistoryQueryKeyPrefix,
  followRepositoryWorkItemsLive,
  kanbanStatusQueryKeyPrefix,
} from "./refresh-work-items-live.js"
import { type Repository, repositoriesQuery } from "./repositories-query.js"
import {
  isRepositorySettingsPathFor,
  markRepositorySettingsOpenedFromInApp,
  parseRepositorySettingsRepositoryId,
  readRepositorySettingsHistoryState,
  wasRepositorySettingsOpenedFromInAppThisDocument,
} from "./routed-dialog.js"
import { openSessionTelemetry } from "./session-telemetry-nav.js"
import { sessionWorktreeParts } from "./session-worktree-line.js"
import { startWorkBannerMessage } from "./start-work-banner-message.js"
import { cx, ui } from "./ui.js"
import { workItemIssueUrl } from "./work-item-issue-url.js"
import { canShowWorkItemResetAction } from "./work-item-job-actions.js"
import { WorkItemOutcomePresentation } from "./work-item-outcome-presentation.js"
import {
  isStatusMessageAlarm,
  lifecycleLaneCssVars,
  lifecycleStepChipClassNameForStatus,
  statusBadgeClassNameForStatus,
  statusMessageClassNameForStatus,
} from "./work-item-progress-chrome.js"
import { workItemPullRequestUrl } from "./work-item-pull-request-url.js"
import { WorkItemResetButton } from "./work-item-reset-button.js"

// Re-export for callers that still import from the home route module.
export type { Repository } from "./repositories-query.js"
export { repositoriesQuery } from "./repositories-query.js"

const graphql = createClient({ url: "/graphql", batch: true })
// Long-lived host folder dialog must not pin co-batched GraphQL operations.

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

type AgentBackendInfo = {
  id: string
  label: string
  configurationMode: string | null
}

const modelsQuery = {
  queryKey: ["models"],
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  queryFn: async () => {
    const result = await graphql.query({
      models: { id: true, thinkingLevels: true, name: true, kind: true },
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
      agentBackends: { id: true, label: true, configurationMode: true },
    })
    return result.agentBackends
  },
}

/** Empty select value means inherit the harness default (null override). */
const HARNESS_DEFAULT_BACKEND_VALUE = ""

/**
 * Dedicated cache identity for GitHub open non-draft Pull Request counts.
 * Independent of {@link repositoriesQuery}: a slow or failed count must not
 * cancel or block the Configured Repositories projection. Failures remain
 * failures so TanStack Query can retain the last successful count map, or
 * present unavailable when there is no successful observation yet.
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
  | "POSTPONED"
  | "COMPLETE"
  | "ABANDONED"
  | "NEEDS_HUMAN"
  | "NEEDS_HUMAN_REVIEW"
  | "WAITING_FOR_WORKER_SLOT"
  | "WAITING_FOR_BLOCKERS"
  | "WAITING_FOR_GITHUB"

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
  postponedUntil: string | null
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
  postponedUntil: true,
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

/** Historical Completed page size (server-paginated archive on /completed). */
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

/** Server `kanbanStatus` projection used by the visual board. */
export type KanbanStatusProjection = {
  readonly repositoryId: string | null
  readonly lanes: readonly {
    readonly id: PipelineLaneId
    readonly label: string
    readonly count: number
    readonly workItems: readonly WorkItem[]
  }[]
}

/**
 * Server-owned six-lane Kanban projection. When `repositoryId` is null, covers
 * every configured Repository (filter applied server-side after the shared
 * source windows). Lane membership and ordering are authoritative; the board
 * does not reclassify.
 */
export const kanbanStatusQuery = (repositoryId: string | null) => ({
  queryKey: [...kanbanStatusQueryKeyPrefix, repositoryId] as const,
  // No cross-key placeholder: a repository filter switch must not paint the
  // previous source set under the new selection while the projection loads.
  queryFn: async (): Promise<KanbanStatusProjection> => {
    const result = await graphql.query({
      kanbanStatus: {
        __args: repositoryId === null ? {} : { repositoryId },
        repository: { id: true },
        lanes: {
          id: true,
          label: true,
          count: true,
          workItems: {
            workItem: workItemFields,
          },
        },
      },
    })
    const status = result.kanbanStatus
    const lanes: KanbanStatusProjection["lanes"][number][] = []
    for (const lane of status.lanes) {
      const pipelineLaneId = pipelineLaneIdFromServerLaneId(lane.id)
      if (pipelineLaneId === null) {
        throw new Error(`Unknown Kanban lane id from server: ${lane.id}`)
      }
      lanes.push({
        id: pipelineLaneId,
        label: lane.label,
        count: lane.count,
        workItems: lane.workItems.map((row) => row.workItem),
      })
    }
    return {
      repositoryId: status.repository?.id ?? null,
      lanes,
    }
  },
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
 * Distinct from the Kanban Merged lane (rolling 24 h via `kanbanStatus`).
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

  // Board tickets come from the server Kanban projection. Keep nested Work
  // Item rows in sync for pause/start/retry so controls stay responsive without
  // waiting for the next SSE refresh. Reset (delete) may leave an empty lane
  // slot until the projection refetches membership.
  for (const [
    queryKey,
    data,
  ] of queryClient.getQueriesData<KanbanStatusProjection>({
    queryKey: kanbanStatusQueryKeyPrefix,
  })) {
    if (data === undefined) continue
    let changed = false
    const lanes = data.lanes.map((lane) => {
      // Only lanes that already hold this repository's items can change from
      // pause/start/retry/reset patches scoped by repositoryId.
      if (!lane.workItems.some((item) => item.repositoryId === repositoryId)) {
        return lane
      }
      const nextItems = update(lane.workItems)
      if (nextItems === undefined) {
        return lane
      }
      const same =
        nextItems.length === lane.workItems.length &&
        nextItems.every((item, index) => item === lane.workItems[index])
      if (same) {
        return lane
      }
      changed = true
      return {
        ...lane,
        workItems: nextItems,
        count: nextItems.length,
      }
    })
    if (changed) {
      queryClient.setQueryData<KanbanStatusProjection>(queryKey, {
        ...data,
        lanes,
      })
    }
  }
}

export function RepositoryCards() {
  const queryClient = useQueryClient()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
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
  // Stale `/repos/<id>/settings` links: in-dialog not-found over Repos (issue #842).
  const routedRepositoryId = parseRepositorySettingsRepositoryId(pathname)
  const repositoryMissing =
    routedRepositoryId !== undefined &&
    !repositories.some((repository) => repository.id === routedRepositoryId)

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
        {repositoryMissing && routedRepositoryId !== undefined && (
          <RepositorySettingsNotFoundDialog repositoryId={routedRepositoryId} />
        )}
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
      {repositoryMissing && routedRepositoryId !== undefined && (
        <RepositorySettingsNotFoundDialog repositoryId={routedRepositoryId} />
      )}
    </>
  )
}

/**
 * Accessible in-dialog “Repository not found” for stale settings links
 * (issue #842). Renders over the Repos background; Close replaces to `/repos`.
 */
function RepositorySettingsNotFoundDialog({
  repositoryId,
}: {
  repositoryId: string
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const navigate = useNavigate()
  const dismissingRouteRef = useRef(false)

  const leaveToRepos = () => {
    dismissingRouteRef.current = true
    dialogRef.current?.close()
    void navigate({
      to: "/repos",
      search: (prev) => prev,
      replace: true,
    })
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) {
      return
    }
    if (!dialog.open) {
      dialog.showModal()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className={ui.dialogPanel}
      aria-labelledby="repo-settings-not-found-title"
      onClose={() => {
        if (dismissingRouteRef.current) {
          dismissingRouteRef.current = false
          return
        }
        void navigate({
          to: "/repos",
          search: (prev) => prev,
          replace: true,
        })
      }}
    >
      <div className={ui.dialogHeader}>
        <p className={ui.dialogKicker}>Repository settings</p>
        <h2 id="repo-settings-not-found-title" className={ui.dialogTitle}>
          Repository not found
        </h2>
        <p className={ui.dialogLede}>
          No configured Repository matches this link. It may have been removed,
          or the address is out of date.
        </p>
      </div>
      <div className={ui.dialogBodySectioned}>
        <Banner
          className={ui.bannerCompact}
          tone="alarm"
          tag="Missing"
          role="alert"
        >
          Repository <code>{repositoryId}</code> is not configured on this
          Harness.
        </Banner>
      </div>
      <div className={ui.dialogFooter}>
        <button
          type="button"
          className={ui.platePrimary}
          onClick={leaveToRepos}
        >
          Close
        </button>
      </div>
    </dialog>
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
  const navigate = useNavigate()
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const repositorySettingsHistoryState = useRouterState({
    select: (s) => readRepositorySettingsHistoryState(s.location.state),
  })
  // Routed `/repos/<id>/settings` open (issue #842). Dialog is route-owned.
  const settingsOpen = isRepositorySettingsPathFor(pathname, repository.id)
  // Optimistic open until the route commits (mirrors harness local || routed).
  const [optimisticSettingsOpen, setOptimisticSettingsOpen] = useState(false)
  const dialogOpen = settingsOpen || optimisticSettingsOpen
  const dismissingRouteRef = useRef(false)
  // Explicit in-app open markers live at module scope so remounting Repos when
  // pushing `/repos/<id>/settings` still treats Cancel/Save as history.back().
  // Full reload clears the module set so close uses replace → `/repos`.
  const settingsOpenNavigatePendingRef = useRef(false)
  // Invalidate in-flight open navigates when the operator dismisses early.
  const settingsOpenIntentGenerationRef = useRef(0)
  // Leave as soon as the settings route commits after an early dismiss or a
  // successful Save that finished before navigate landed (issue #842 review).
  const leaveWhenSettingsRouteCommitsRef = useRef(false)
  const dismissSettingsRef = useRef<
    (options?: { ignoreBlocker?: boolean }) => void
  >(() => {})
  const [githubTokenCreated, setGithubTokenCreated] = useState(false)
  const [gitlabTokenCreated, setGitlabTokenCreated] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [awaitingRefresh, setAwaitingRefresh] = useState(false)
  const issuesChangeCountOnRefresh = useRef(issuesChangeCount)
  const settingsDialogRef = useRef<HTMLDialogElement>(null)
  // Catalog queries enable for routed open and the optimistic open window so
  // the first paint after menu click is not a cold catalog (issue #842 review).
  const config = useQuery({ ...configQuery, enabled: dialogOpen })
  const models = useQuery({ ...modelsQuery, enabled: dialogOpen })
  const agentBackends = useQuery({
    ...agentBackendsQuery,
    enabled: dialogOpen,
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
  const [previewProvider, setPreviewProvider] = useState<{
    id: string
    label: string
  } | null>(null)
  const [previewWarnings, setPreviewWarnings] = useState<readonly string[]>([])
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
      // Successful Save leaves the route (issue #842).
      dismissSettingsRef.current({ ignoreBlocker: true })
    },
  })

  // Block Back (and other route leaves) while Save is in flight so navigation
  // cannot race an in-progress Repository settings update (issue #842).
  const updateSettingsPendingRef = useRef(false)
  updateSettingsPendingRef.current = updateSettings.isPending
  const shouldBlockRepositorySettingsLeave = useCallback(
    () => updateSettingsPendingRef.current,
    [],
  )
  useBlocker({
    shouldBlockFn: shouldBlockRepositorySettingsLeave,
    enableBeforeUnload: updateSettings.isPending,
    disabled: !updateSettings.isPending || !settingsOpen,
  })

  const applyRepoModelPrefs = (prefs: DraftModelPrefs) => {
    setDefaultModel(prefs.defaultModel ?? "")
    setDefaultVariant(prefs.defaultThinkingLevel ?? "")
    setReviewModel(prefs.reviewModel ?? "")
    setReviewVariant(prefs.reviewThinkingLevel ?? "")
  }

  const currentDraftModelPrefs = (): DraftModelPrefs => ({
    defaultModel: defaultModel.trim() === "" ? null : defaultModel.trim(),
    defaultThinkingLevel:
      defaultThinkingLevel.trim() === "" ? null : defaultThinkingLevel.trim(),
    reviewModel: reviewModel.trim() === "" ? null : reviewModel.trim(),
    reviewThinkingLevel:
      reviewThinkingLevel.trim() === "" ? null : reviewThinkingLevel.trim(),
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
      setPreviewProvider(null)
      setPreviewWarnings([])
      setHarnessPrefsForDraft(null)
    } else {
      setPreviewPending(true)
      setPreviewError(null)
      setPreviewModels(null)
      setPreviewProvider(null)
      setPreviewWarnings([])
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

  /**
   * Reset form session state and refresh indefinitely-cached catalogs on open
   * (issue #838). Shared by explicit open and routed enter (direct / Forward).
   */
  const prepareSettingsSessionRef = useRef(() => {})
  prepareSettingsSessionRef.current = () => {
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
    setPreviewProvider(null)
    setPreviewWarnings([])
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
    // Refresh provider-mode and catalog metadata on every open. Both queries
    // are cached indefinitely, so a long-open browser would otherwise keep the
    // catalog (and Claude configurationMode) from before a Harness restart and
    // offer models the running Harness no longer accepts (issue #838).
    void config.refetch()
    void models.refetch()
    void agentBackends.refetch()
  }

  /**
   * Leave the `/repos/<id>/settings` route: Back to the in-app origin when
   * this SPA session opened settings explicitly, else replace with `/repos`
   * so Forward cannot reopen a direct-link or post-refresh entry.
   * Stored on a ref so the route-sync effect can call the latest leave without
   * re-running on every render (unstable function identity).
   */
  const leaveSettingsRouteRef = useRef<
    (options?: { ignoreBlocker?: boolean }) => void
  >(() => {})
  leaveSettingsRouteRef.current = (options?: { ignoreBlocker?: boolean }) => {
    const ignoreBlocker = options?.ignoreBlocker === true
    const openedFromInApp =
      wasRepositorySettingsOpenedFromInAppThisDocument(repository.id) &&
      repositorySettingsHistoryState?.kind === "in-app-origin"
    if (openedFromInApp && router.history.canGoBack()) {
      router.history.back({ ignoreBlocker })
      return
    }
    void navigate({
      to: "/repos",
      search: (prev) => prev,
      replace: true,
      ignoreBlocker,
    })
  }
  const leaveSettingsRoute = (options?: { ignoreBlocker?: boolean }) => {
    leaveSettingsRouteRef.current(options)
  }

  const dismissSettings = (options?: { ignoreBlocker?: boolean }) => {
    if (updateSettings.isPending && options?.ignoreBlocker !== true) {
      return
    }
    // Early leave while open navigate is still in flight (Cancel/Escape, or
    // successful Save before the route commits). Invalidate the open intent
    // and leave when `/repos/<id>/settings` lands so the dialog cannot reopen.
    if (
      !settingsOpen &&
      (settingsOpenNavigatePendingRef.current || optimisticSettingsOpen)
    ) {
      settingsOpenNavigatePendingRef.current = false
      settingsOpenIntentGenerationRef.current += 1
      leaveWhenSettingsRouteCommitsRef.current = true
      setOptimisticSettingsOpen(false)
      const dialog = settingsDialogRef.current
      // Only pair dismissingRouteRef with an actual close so onClose clears it;
      // otherwise Escape on a later open would skip leaveSettingsRoute.
      if (dialog?.open) {
        dismissingRouteRef.current = true
        dialog.close()
      }
      return
    }
    if (!settingsOpen) {
      settingsDialogRef.current?.close()
      return
    }
    leaveWhenSettingsRouteCommitsRef.current = false
    setOptimisticSettingsOpen(false)
    // Escape already closed the native dialog before onClose → dismissSettings.
    // Only set dismissingRouteRef when we actually close so the flag cannot stick
    // and break Escape on a subsequent open (issue #842 review).
    const dialog = settingsDialogRef.current
    if (dialog?.open) {
      dismissingRouteRef.current = true
      dialog.close()
    }
    leaveSettingsRoute(options)
  }
  dismissSettingsRef.current = dismissSettings

  /** Explicit Repository settings openers (card menu). */
  const openSettings = () => {
    leaveWhenSettingsRouteCommitsRef.current = false
    prepareSettingsSessionRef.current()
    if (settingsOpen || settingsOpenNavigatePendingRef.current) {
      if (
        settingsDialogRef.current !== null &&
        !settingsDialogRef.current.open
      ) {
        settingsDialogRef.current.showModal()
      }
      return
    }
    markRepositorySettingsOpenedFromInApp(repository.id)
    const openGeneration = ++settingsOpenIntentGenerationRef.current
    settingsOpenNavigatePendingRef.current = true
    setOptimisticSettingsOpen(true)
    // Open immediately so focus trap matches pre-route UX; the route effect
    // remains the source of truth for direct/forward entry and Back close.
    if (settingsDialogRef.current !== null && !settingsDialogRef.current.open) {
      settingsDialogRef.current.showModal()
    }
    void navigate({
      to: "/repos/$repositoryId/settings",
      params: { repositoryId: repository.id },
      search: (prev) => prev,
      state: (prev) => {
        const next = { ...prev }
        Object.assign(next, {
          repositorySettings: { kind: "in-app-origin" as const },
        })
        return next
      },
    }).finally(() => {
      if (settingsOpenIntentGenerationRef.current === openGeneration) {
        settingsOpenNavigatePendingRef.current = false
      }
    })
  }

  // Sync native <dialog> with the routed open flag (issue #842).
  useEffect(() => {
    const dialog = settingsDialogRef.current
    if (dialog === null) {
      return
    }
    if (settingsOpen) {
      // Early dismiss or Save completed before navigate settled: leave without reopen.
      if (leaveWhenSettingsRouteCommitsRef.current) {
        leaveWhenSettingsRouteCommitsRef.current = false
        setOptimisticSettingsOpen(false)
        // Only set dismissingRouteRef when closing so it cannot stick true.
        if (dialog.open) {
          dismissingRouteRef.current = true
          dialog.close()
        }
        leaveSettingsRouteRef.current({ ignoreBlocker: true })
        return
      }
      setOptimisticSettingsOpen(false)
      if (!dialog.open) {
        // Entering via route (direct, Forward, or explicit navigate) needs a
        // fresh session so abandoned drafts are not restored.
        prepareSettingsSessionRef.current()
        dialog.showModal()
      }
      return
    }
    setOptimisticSettingsOpen(false)
    if (dialog.open) {
      dismissingRouteRef.current = true
      dialog.close()
    }
  }, [settingsOpen])

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
    if (!dialogOpen || harnessDefaultBackendFromConfig === null) {
      return
    }
    const harnessDefault = harnessDefaultBackendFromConfig
    const effective = selectedAgentBackend ?? harnessDefault
    if (effective === harnessDefault) {
      setHarnessPrefsForDraft(null)
      setPreviewModels(null)
      setPreviewProvider(null)
      setPreviewWarnings([])
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
    setPreviewProvider(null)
    setPreviewWarnings([])
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
              models: {
                id: true,
                thinkingLevels: true,
                name: true,
                kind: true,
              },
              provider: { id: true, label: true },
              warnings: true,
            },
          }),
        ])
        if (generation !== previewGenerationRef.current) {
          return
        }
        setHarnessPrefsForDraft(prefsResult.harnessModelPrefs)
        const preview = previewResult.previewAgentBackend
        setPreviewProvider(preview.provider)
        setPreviewWarnings(preview.warnings ?? [])
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
        setPreviewProvider(null)
        setPreviewWarnings([])
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
  }, [dialogOpen, harnessDefaultBackendFromConfig, selectedAgentBackend])

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
  const modelBackendId = draftEffective
  const catalogLoaded = catalogModels !== undefined
  // configurationMode comes only from agentBackends. Until that list has
  // successfully loaded, Claude mode is unknown — fail closed (Save blocked) so
  // a Bedrock-mode harness cannot be shown first-party guidance while the query
  // is pending or failed (issue #828 review). Catalog membership itself is
  // required for every Agent Backend (issue #838).
  const agentBackendsModeReady =
    !agentBackends.isPending &&
    !agentBackends.isError &&
    agentBackends.data !== undefined
  const claudeConfigurationModeUnresolved =
    modelBackendId === CLAUDE_AGENT_BACKEND_ID && !agentBackendsModeReady
  const modelConfigurationMode =
    (agentBackends.data ?? []).find((backend) => backend.id === modelBackendId)
      ?.configurationMode ?? null
  const claudeBedrockStrict =
    agentBackendsModeReady &&
    isClaudeBedrockConfigurationMode(modelBackendId, modelConfigurationMode)
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
  const buildVariants = thinkingLevelsForModel(
    catalogModels,
    buildVariantSourceModel,
  )
  const reviewThinkingLevels = thinkingLevelsForModel(
    catalogModels,
    reviewThinkingLevelSourceModel,
  )
  // Effort source may be the override or an inherited harness model string.
  // Only claim "unavailable" once a catalog loaded so a pending fetch cannot
  // flash an alarm for a value that may yet match (issue #838).
  const buildVariantSourceUnavailable =
    catalogLoaded &&
    isUnavailableCatalogModel({
      modelId: buildVariantSourceModel,
      catalogModelIds: modelIds,
    })
  const reviewThinkingLevelSourceUnavailable =
    catalogLoaded &&
    isUnavailableCatalogModel({
      modelId: reviewThinkingLevelSourceModel,
      catalogModelIds: modelIds,
    })
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
  // isFetching, not isPending: opening Settings refetches, and React Query
  // would otherwise keep serving the previous catalog while that request is in
  // flight — exactly the indefinitely-cached catalog a Harness restart must
  // invalidate (issue #838). Treat a refresh as "no catalog yet" so no stale
  // model is offered and Save stays blocked until the current one arrives.
  const modelsLoading =
    dialogOpen &&
    (usesPreviewCatalog
      ? previewPending || config.isFetching
      : models.isFetching || config.isFetching || agentBackends.isFetching)
  // A backend-draft change may only be saved once its Preview catalog resolved,
  // so the model overrides are validated against the next Effective backend.
  const catalogReadyForModelValidation = usesPreviewCatalog
    ? !previewPending && previewError === null && previewModels !== null
    : !models.isFetching && !models.isError && models.data !== undefined
  const discoveryWarningsForModels = usesPreviewCatalog ? previewWarnings : []
  const catalogFailed =
    !modelsLoading &&
    !modelsDisabled &&
    (usesPreviewCatalog
      ? previewError !== null
      : models.isError || agentBackends.isError)
  const catalogLoading =
    modelsLoading ||
    modelsDisabled ||
    (!catalogFailed && catalogModels === undefined)
  const catalogState = {
    backendId: modelBackendId,
    configurationMode: modelConfigurationMode,
    catalogLoading,
    catalogFailed,
    catalogModels,
    discoveryWarnings: discoveryWarningsForModels,
  }
  // Repository overrides are optional: empty inherits the harness default and
  // saves even without a healthy catalog. Any explicit value must be in the
  // current catalog of the next Effective Agent Backend (issue #838).
  const blockSaveForBuildModel = blocksAgentModelSave({
    ...catalogState,
    modelId: defaultModel,
    requireSelection: false,
  })
  const blockSaveForReviewModel = blocksAgentModelSave({
    ...catalogState,
    modelId: reviewModel,
    requireSelection: false,
  })
  const catalogUnusable =
    catalogLoading ||
    catalogFailed ||
    catalogModels === undefined ||
    catalogModels.length === 0
  // With an explicit override, explain why it blocks Save. While inheriting,
  // still explain an unusable catalog (nothing is selectable) without claiming
  // a selection is required.
  const buildModelBlockReason =
    defaultModel.length > 0
      ? agentModelSaveBlockReason({
          ...catalogState,
          modelId: defaultModel,
          requireSelection: false,
        })
      : catalogUnusable
        ? agentModelCatalogNotice(catalogState)
        : null
  const reviewModelBlockReason =
    reviewModel.length > 0
      ? agentModelSaveBlockReason({
          ...catalogState,
          modelId: reviewModel,
          requireSelection: false,
        })
      : catalogUnusable
        ? agentModelCatalogNotice(catalogState)
        : null
  // Never disable on an unusable catalog: clearing a stale override back to
  // inheritance must stay reachable (issue #838).
  const modelSelectDisabled = modelsDisabled
  // Single Save gate for button + form onSubmit (Enter must not bypass #828).
  const repositorySettingsSaveBlocked =
    updateSettings.isPending ||
    // Always block while Claude configuration mode is unknown (not only when
    // the backend draft is changing) — mirrors Harness gating on status pending.
    claudeConfigurationModeUnresolved ||
    (backendChangeBlocked &&
      selectedAgentBackend !== repository.selectedAgentBackend) ||
    (backendDraftChanging && modelsLoading) ||
    (backendDraftChanging &&
      usesPreviewCatalog &&
      !catalogReadyForModelValidation) ||
    (backendDraftChanging && usesPreviewCatalog && previewError !== null) ||
    blockSaveForBuildModel ||
    blockSaveForReviewModel

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (repositorySettingsSaveBlocked) {
      return
    }
    updateSettings.mutate({
      repositoryId: repository.id,
      forge,
      forgeHost: forgeHost.trim(),
      projectPath: projectPath.trim(),
      paused,
      selectedAgentBackend,
      defaultModel: defaultModel.trim() === "" ? null : defaultModel.trim(),
      defaultThinkingLevel:
        defaultThinkingLevel.trim() === "" ? null : defaultThinkingLevel.trim(),
      reviewModel: reviewModel.trim() === "" ? null : reviewModel.trim(),
      reviewThinkingLevel:
        reviewThinkingLevel.trim() === "" ? null : reviewThinkingLevel.trim(),
      autoMerge,
      includeAllIssueAuthors,
      waitForReadyForReviewChecks,
    })
  }

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
  const { data: relevantIssues } = useQuery({
    ...issuesQuery(repository.id),
    enabled: repository.issuesReconciledAt !== null,
  })
  const hasNoRelevantIssues =
    repository.issuesReconciledAt !== null && relevantIssues?.length === 0
  // Wall-clock tick so a previously-fresh projection can cross the stale
  // threshold while this card stays mounted (failed polls never invalidate).
  const nowMs = useNowMs(repository.issuesReconciledAt !== null, 30_000)
  const issuesProjectionStale = isIssueProjectionStale(
    repository.issuesReconciledAt,
    nowMs,
  )

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
        onClose={() => {
          // Escape (or other user dismiss) closes the native dialog first; keep
          // URL + dialog synchronized, including during pending open navigate.
          if (dismissingRouteRef.current) {
            dismissingRouteRef.current = false
            return
          }
          dismissSettings()
        }}
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
          <div className={ui.dialogBodySectioned}>
            <section
              className={ui.dialogSection}
              aria-labelledby={`repo-sec-identity-${repository.id}`}
            >
              <div className={ui.dialogSectionHead}>
                <h3
                  id={`repo-sec-identity-${repository.id}`}
                  className={ui.dialogSectionTitle}
                >
                  Forge identity
                </h3>
                <span className={ui.dialogSectionMeta}>Path</span>
              </div>
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
            </section>

            <section
              className={ui.dialogSection}
              aria-labelledby={`repo-sec-options-${repository.id}`}
            >
              <div className={ui.dialogSectionHead}>
                <h3
                  id={`repo-sec-options-${repository.id}`}
                  className={ui.dialogSectionTitle}
                >
                  Options
                </h3>
                <span className={ui.dialogSectionMeta}>Repo preferences</span>
              </div>
              <label className={ui.dialogCheck}>
                <input
                  type="checkbox"
                  className={ui.dialogCheckInput}
                  checked={paused}
                  onChange={(event) => setPaused(event.target.checked)}
                />
                Paused
                <span className={cx(ui.dialogFieldHint, ui.dialogCheckHint)}>
                  Skip autonomous work selection
                </span>
              </label>
              <label className={ui.dialogCheck}>
                <input
                  type="checkbox"
                  className={ui.dialogCheckInput}
                  checked={autoMerge}
                  onChange={(event) => setAutoMerge(event.target.checked)}
                />
                Auto-merge
                <span className={cx(ui.dialogFieldHint, ui.dialogCheckHint)}>
                  Allow clanker merge when risk is low
                </span>
              </label>
              <label className={ui.dialogCheck}>
                <input
                  type="checkbox"
                  className={ui.dialogCheckInput}
                  checked={includeAllIssueAuthors}
                  onChange={(event) =>
                    setIncludeAllIssueAuthors(event.target.checked)
                  }
                />
                Include all Issue Authors
                <span className={cx(ui.dialogFieldHint, ui.dialogCheckHint)}>
                  Relevant Issues from every author after Refresh
                </span>
              </label>
              <label className={ui.dialogField}>
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    className={ui.dialogCheckInput}
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
            </section>

            <section
              className={ui.dialogSection}
              aria-labelledby={`repo-sec-agent-${repository.id}`}
            >
              <div className={ui.dialogSectionHead}>
                <h3
                  id={`repo-sec-agent-${repository.id}`}
                  className={ui.dialogSectionTitle}
                >
                  Agent backend
                </h3>
                <span className={ui.dialogSectionMeta}>Override</span>
              </div>
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

              {usesPreviewCatalog && !previewPending && (
                <div className={ui.dialogStatusLabel}>
                  <p className="m-0">
                    {formatAgentBackendStatusLabel({
                      backendLabel:
                        (agentBackends.data ?? []).find(
                          (backend) => backend.id === draftEffective,
                        )?.label ?? draftEffective,
                      kind: previewError !== null ? "UNAVAILABLE" : "READY",
                      provider: previewProvider,
                      // Reason text is on the Banner below when preview fails.
                    })}
                  </p>
                  {previewError === null && (
                    <AgentBackendWarnings warnings={previewWarnings} />
                  )}
                </div>
              )}

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
                  Preview failed: {previewError}. Model fields stay disabled
                  until preview succeeds.
                  {backendDraftChanging
                    ? " Changing the effective backend cannot be saved until preview succeeds."
                    : " Non-model settings can still be saved."}
                </Banner>
              )}
            </section>

            <section
              className={ui.dialogSection}
              aria-labelledby={`repo-sec-models-${repository.id}`}
            >
              <div className={ui.dialogSectionHead}>
                <h3
                  id={`repo-sec-models-${repository.id}`}
                  className={ui.dialogSectionTitle}
                >
                  Models
                </h3>
                <span className={ui.dialogSectionMeta}>Build · Review</span>
              </div>

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
                  <AgentModelSelect
                    label="Build model"
                    name="defaultModel"
                    value={defaultModel}
                    models={catalogModels}
                    catalogLoading={catalogLoading}
                    allowClear
                    required={false}
                    disabled={modelSelectDisabled}
                    placeholder={`Harness default (${harnessDefaultModel})`}
                    emptyCatalogLabel={
                      claudeBedrockStrict
                        ? "No Bedrock profiles available"
                        : "No Agent Models available"
                    }
                    blockReason={buildModelBlockReason}
                    hint={
                      claudeBedrockStrict
                        ? "Empty inherits harness default. Otherwise choose a discovered Bedrock inference profile."
                        : "Empty inherits harness default. Otherwise choose a model from the catalog."
                    }
                    onChange={(nextModel) => {
                      setDefaultModel(nextModel)
                      const sourceModel =
                        nextModel.length > 0 ? nextModel : harnessBuildForSource
                      const nextVariants = thinkingLevelsForModel(
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
                            thinkingLevelsForModel(catalogModels, reviewSource),
                          ),
                        )
                      }
                    }}
                  />
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
                      Build effort (thinking) override is unavailable — this
                      model has no effort (thinking) options. Use harness
                      default or pick another model.
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
                            {formatUnavailableVariantLabel(
                              defaultThinkingLevel,
                            )}
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
                  <AgentModelSelect
                    label="Review model"
                    name="reviewModel"
                    value={reviewModel}
                    models={catalogModels}
                    catalogLoading={catalogLoading}
                    allowClear
                    required={false}
                    disabled={modelSelectDisabled}
                    placeholder={`Harness default (${harnessReviewModel})`}
                    emptyCatalogLabel={`Harness default (${harnessReviewModel})`}
                    blockReason={reviewModelBlockReason}
                    hint={null}
                    onChange={(nextModel) => {
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
                          thinkingLevelsForModel(catalogModels, sourceModel),
                        ),
                      )
                    }}
                  />
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
                      model has no effort (thinking) options. Use harness
                      default or pick another model.
                    </p>
                  ) : (
                    <label className={ui.dialogField}>
                      Review effort (thinking)
                      <select
                        className={ui.dialogInput}
                        value={reviewThinkingLevel}
                        onChange={(event) =>
                          setReviewVariant(event.target.value)
                        }
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
                            {formatUnavailableVariantLabel(reviewThinkingLevel)}
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
            </section>

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
              onClick={() => dismissSettings()}
              disabled={updateSettings.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={ui.platePrimary}
              aria-busy={updateSettings.isPending || undefined}
              disabled={repositorySettingsSaveBlocked}
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
              <dt>Include all Issue Authors</dt>
              <dd>
                {repository.includeAllIssueAuthors ? "Enabled" : "Disabled"}
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
              <dt>Wait for ready checks</dt>
              <dd>
                {repository.waitForReadyForReviewChecks
                  ? "Enabled"
                  : "Disabled"}
              </dd>
            </div>
            <div className={ui.repoMetaRow}>
              <dt>Auto-merge</dt>
              <dd>{repository.autoMerge ? "Enabled" : "Disabled"}</dd>
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
              <h3 className={ui.repoIssuesKicker}>
                {hasNoRelevantIssues ? "No relevant issues" : "Relevant issues"}
              </h3>
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
              <p className={ui.repoIssuesUnrefreshed}>Not refreshed yet.</p>
            ) : (
              <>
                {issuesProjectionStale && (
                  <Banner
                    className={cx(ui.bannerCompact, "mb-2")}
                    tone="guidance"
                    tag="Stale"
                    role="status"
                  >
                    {formatLastRefreshedAgo(
                      repository.issuesReconciledAt,
                      nowMs,
                    )}
                    . Issues may be out of date.
                  </Banner>
                )}
                <Suspense fallback={<RepositoryIssuesSkeleton />}>
                  <RepositoryIssues
                    repository={repository}
                    workItems={workItems}
                    workItemsLoading={workItemsLoading}
                  />
                </Suspense>
              </>
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
  // Session Telemetry is route-owned at root (`/session/<work-item-id>/telemetry`).
  const navigate = useNavigate()
  const onOpenSession = (workItemId: string, sessionId: string) => {
    void openSessionTelemetry({
      navigate,
      workItemId,
      sessionId,
    })
  }

  if (issues.length === 0) {
    return (
      <p className={ui.repoIssuesEmpty}>
        Label {repository.forge === "gitlab" ? "GitLab" : "GitHub"} issues with{" "}
        <code className={ui.guidanceCode}>ready-for-agent</code> for them to
        show up here. If an issue is a child issue, the parent itself cannot be
        a child issue too.
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
            {startWorkBannerMessage({
              error: implementAll.error,
              fallback:
                "Could not start Implement all with auto-merge. Refresh the issues and try again.",
            })}
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
  const startImplementNow = () => {
    implementLocally.reset()
    queueIssue.reset()
    implementNow.mutate()
  }
  const startImplementLocally = () => {
    implementNow.reset()
    queueIssue.reset()
    implementLocally.mutate()
  }
  const startQueue = () => {
    implementNow.reset()
    implementLocally.reset()
    queueIssue.mutate()
  }
  const runMenuAction = ({ action }: { readonly action: () => void }) => {
    setMenuOpen(false)
    action()
  }

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
        {/*
          Flow container (div, not span): title column holds block companions
          (lifecycle, Banner, blocked-by <p>) under the title when the number
          track grows for long GitLab iids.
        */}
        <div className="min-w-0">
          <span className={ui.repoIssueTitleRow}>
            <a className={ui.repoIssueTitleInline} href={issue.url}>
              {issue.title}
            </a>
            {canImplement && (
              <button
                type="button"
                className={ui.repoIssueImplementBtn}
                aria-label={`Implement issue #${issue.issueNumber}`}
                disabled={implementPending}
                onClick={startImplementNow}
              >
                <svg
                  aria-hidden="true"
                  className={ui.repoIssueImplementIcon}
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.12-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z" />
                </svg>
                {implementPending ? "Starting..." : "Implement"}
              </button>
            )}
          </span>
          {issue.issueAuthor !== null && issue.issueAuthor !== "" && (
            <span className={ui.repoIssueAuthor}>{issue.issueAuthor}</span>
          )}
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
              {startWorkBannerMessage({
                error: queueIssue.isError
                  ? queueIssue.error
                  : implementNow.isError
                    ? implementNow.error
                    : implementLocally.error,
                fallback: queueIssue.isError
                  ? "Could not queue issue. Refresh the issues and try again."
                  : "Could not start implementation. Refresh the issues and try again.",
              })}
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
        </div>
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
                        onClick={() =>
                          runMenuAction({ action: startImplementNow })
                        }
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
                        onClick={() =>
                          runMenuAction({ action: startImplementLocally })
                        }
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
                      onClick={() => runMenuAction({ action: startQueue })}
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
    </li>
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
  // cards (held Queue and other unfinished work) keep it; Complete/Abandoned
  // terminal history never does. Terminal Failed Attention cards keep delete so
  // obsolete failures can be cleared. Needs Human stays on Working and keeps cancel.
  const canReset = canShowWorkItemResetAction({
    compact,
    isTerminal: workItem.isTerminal,
    isNeedsHuman: status === "NEEDS_HUMAN",
    isFailed: status === "FAILED",
  })
  const dataUpdatedAt = [
    ...queryClient.getQueriesData({
      queryKey: ["work-items", workItem.repositoryId],
    }),
    ...queryClient.getQueriesData({ queryKey: kanbanStatusQueryKeyPrefix }),
  ].reduce(
    (latest, [queryKey]) =>
      Math.max(latest, queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0),
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
  const renderLifecycleChip = ({
    lifecycleLabel,
    isFocusLane = false,
  }: {
    readonly lifecycleLabel: LifecycleLabelChip
    readonly isFocusLane?: boolean
  }) => {
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
    const chipClassName = cx(
      lifecycleStepChipClassNameForStatus(lifecycleLabel.status),
      isFocusLane && lifecycleLabel.status === "RUNNING"
        ? ui.lifecycleFocusRunningChip
        : null,
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
      <li
        key={`${lifecycleLabel.phase}-${lifecycleLabel.label}`}
        className="flex min-w-0 max-w-full"
      >
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
      readonly isFocusLane?: boolean
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
      {chips.map((lifecycleLabel) =>
        renderLifecycleChip({
          lifecycleLabel,
          isFocusLane: options?.isFocusLane,
        }),
      )}
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
          // Summary legs share one wrap row (like archive foot); expanded
          // fine-grained chips are full-width strips beneath that row.
          <div className={ui.lifecycleLegBlocks}>
            <div className={ui.legRow}>
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
                    <button
                      key={block.lane}
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
                        isFocusLane: true,
                      })}
                    </div>
                  )
                }
                return (
                  <div key="full-list" className="min-w-0 max-w-full">
                    {renderChipList(block.chips, {
                      className:
                        "m-0 flex min-w-0 max-w-full list-none flex-wrap gap-1 p-0",
                    })}
                  </div>
                )
              })}
            </div>
            {chipBlocks.map((block) => {
              if (block.kind !== "earlier-lane" || !block.expanded) {
                return null
              }
              const chipsId = `lifecycle-lane-${workItem.id}-${block.lane}`
              return (
                <div
                  key={`${block.lane}-expanded`}
                  className="min-w-0 max-w-full"
                >
                  {renderChipList(block.chips, {
                    id: chipsId,
                    className:
                      "m-0 flex min-w-0 max-w-full list-none flex-wrap gap-1 p-0",
                    ariaLabel: `${block.laneLabel} lifecycle steps`,
                  })}
                </div>
              )
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
