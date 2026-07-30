import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useLocation,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools"
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react"
import { createClient } from "@ready-for-agent/graphql-client"
import { READY_FOR_AGENT_VERSION_LABEL } from "../generated/version"
import appCss from "../styles.css?url"

export interface RouterContext {
  queryClient: QueryClient
}

const graphql = createClient({ url: "/graphql" })

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
        unfinishedWorkItemCount: true,
        // Scoped gate for changing the harness default (inheriting repos only).
        blockingUnfinishedWorkItemCount: true,
      },
    })
    return result.config
  },
}

const agentBackendStatusSelection = {
  backend: { id: true, label: true },
  selectedBackend: { id: true, label: true },
  activeBackend: { id: true, label: true },
  kind: true,
  reason: true,
  models: { id: true, thinkingLevels: true },
} as const

const agentBackendStatusQuery = {
  queryKey: ["agentBackendStatus"],
  queryFn: async () => {
    const result = await graphql.query({
      agentBackendStatuses: agentBackendStatusSelection,
      // Legacy singular surface for the harness default (derived server-side).
      agentBackendStatus: agentBackendStatusSelection,
      agentBackends: { id: true, label: true },
    })
    return result
  },
}

type AgentModelOption = {
  id: string
  thinkingLevels: readonly string[]
}

type AgentBackendStatusRow = {
  backend: { id: string; label: string }
  selectedBackend: { id: string; label: string }
  activeBackend: { id: string; label: string }
  kind: "READY" | "UNAVAILABLE"
  reason: string | null
  models: readonly AgentModelOption[]
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

const isBuildModelConfigured = (
  config:
    | {
        defaultModel: string | null
      }
    | null
    | undefined,
): boolean =>
  config != null &&
  config.defaultModel != null &&
  config.defaultModel.length > 0

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1.0",
      },
      { title: "Ready for Agent" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <div className="field-rule mx-auto mt-12 max-w-xl p-8 text-center">
      <p>Page not found.</p>
      <Link
        className="mt-2 inline-block text-oxblood underline decoration-rule underline-offset-4 hover:text-oxblood-deep"
        to="/"
      >
        Back home
      </Link>
    </div>
  ),
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen min-w-80 bg-paper font-sans text-ink antialiased [font-synthesis:none] [text-rendering:optimizeLegibility]">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

// Shared layout only — Router merges className with active/inactive props, so
// mutually exclusive visual utilities must not live on the base class string.
const primaryNavLinkClassName =
  "inline-flex items-center gap-2 border px-3 py-1.5 text-xs font-semibold tracking-[0.14em] uppercase transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood"

// Inactive: muted gray-out; hover still reads as clickable.
const primaryNavLinkInactiveClassName =
  "border-rule-2 bg-panel text-ink-faint hover:border-ink-soft hover:bg-paper-2 hover:text-ink-2"

// Selected: restrained contrast (stronger border/text, light fill — not a solid ink pill).
const primaryNavLinkActiveClassName = "border-ink bg-paper-2 text-ink"

// Settings is a non-route action; keep it in the same family as inactive nav.
const primaryNavActionClassName =
  "inline-flex items-center gap-2 border border-rule-2 bg-panel px-3 py-1.5 text-xs font-semibold tracking-[0.14em] text-ink-faint uppercase transition hover:border-ink-soft hover:bg-paper-2 hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood"

function HomeNavIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9 21v-6h6v6" />
    </svg>
  )
}

function ReposNavIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 7.5c0-1.5 3.6-2.5 8-2.5s8 1 8 2.5v9c0 1.5-3.6 2.5-8 2.5s-8-1-8-2.5v-9Z" />
      <path d="M4 7.5c0 1.5 3.6 2.5 8 2.5s8-1 8-2.5" />
      <path d="M4 12c0 1.5 3.6 2.5 8 2.5s8-1 8-2.5" />
    </svg>
  )
}

function KanbanNavIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="3.5" y="4" width="4.5" height="16" rx="0.5" />
      <rect x="9.75" y="4" width="4.5" height="10" rx="0.5" />
      <rect x="16" y="4" width="4.5" height="13" rx="0.5" />
    </svg>
  )
}

function CompletedNavIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function RootComponent() {
  // Kanban needs the full viewport for six pipeline lanes; other routes keep
  // the shared 88rem reading-width cap. Gutters stay on every route.
  const pathname = useLocation({ select: (location) => location.pathname })
  const isKanbanPage = pathname === "/kanban"
  const shellClassName = [
    "mx-auto min-h-screen w-full px-5 py-6 sm:px-8 lg:px-12",
    isKanbanPage ? undefined : "max-w-[88rem]",
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ")

  return (
    <div className={shellClassName}>
      <nav
        aria-label="Primary"
        className="primary-nav mb-2 flex flex-wrap items-start gap-x-5 gap-y-3 pb-3"
      >
        <div className="grid gap-1">
          <h1 className="m-0 font-serif text-[clamp(1.6rem,3.2vw,2.25rem)] leading-none font-semibold tracking-[-0.012em]">
            <Link
              to="/"
              className="text-ink hover:text-oxblood"
              activeProps={{ className: "text-ink" }}
              activeOptions={{ exact: true }}
            >
              Clanker Harness
            </Link>
          </h1>
          <span
            className="font-mono text-xs tabular-nums tracking-[0.16em] text-ink-faint uppercase"
            title={`Ready for Agent ${READY_FOR_AGENT_VERSION_LABEL}`}
          >
            {READY_FOR_AGENT_VERSION_LABEL}
          </span>
        </div>
        <SettingsButton
          leading={
            <>
              <Link
                to="/"
                activeOptions={{ exact: true }}
                className={primaryNavLinkClassName}
                inactiveProps={{ className: primaryNavLinkInactiveClassName }}
                activeProps={{ className: primaryNavLinkActiveClassName }}
              >
                <HomeNavIcon />
                Home
              </Link>
              <Link
                to="/repos"
                className={primaryNavLinkClassName}
                inactiveProps={{ className: primaryNavLinkInactiveClassName }}
                activeProps={{ className: primaryNavLinkActiveClassName }}
              >
                <ReposNavIcon />
                Repos
              </Link>
              <Link
                to="/kanban"
                className={primaryNavLinkClassName}
                inactiveProps={{ className: primaryNavLinkInactiveClassName }}
                activeProps={{ className: primaryNavLinkActiveClassName }}
              >
                <KanbanNavIcon />
                Kanban
              </Link>
              <Link
                to="/completed"
                className={primaryNavLinkClassName}
                inactiveProps={{ className: primaryNavLinkInactiveClassName }}
                activeProps={{ className: primaryNavLinkActiveClassName }}
              >
                <CompletedNavIcon />
                Completed
              </Link>
            </>
          }
        />
      </nav>
      <Outlet />
      <ReactQueryDevtools buttonPosition="bottom-left" />
      <TanStackRouterDevtools position="bottom-right" />
    </div>
  )
}

function SettingsButton({ leading }: { leading: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [autoOpenAttempted, setAutoOpenAttempted] = useState(false)
  const config = useQuery(configQuery)
  const backendStatus = useQuery(agentBackendStatusQuery)
  const models = useQuery({ ...modelsQuery, enabled: dialogOpen })
  const [selectedAgentBackend, setSelectedAgentBackend] = useState("opencode")
  const [defaultModel, setDefaultModel] = useState("")
  const [defaultThinkingLevel, setDefaultVariant] = useState("")
  const [reviewModel, setReviewModel] = useState("")
  const [reviewThinkingLevel, setReviewVariant] = useState("")
  const [maxConcurrentAgentTurns, setMaxConcurrentOpencodeSessions] =
    useState("2")
  const [maxConcurrentWorkItems, setMaxConcurrentWorkItems] = useState("5")
  const [previewModels, setPreviewModels] = useState<
    readonly AgentModelOption[] | null
  >(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewPending, setPreviewPending] = useState(false)
  const previewGenerationRef = useRef(0)
  const buildConfigured = isBuildModelConfigured(config.data)
  const statuses: readonly AgentBackendStatusRow[] =
    backendStatus.data?.agentBackendStatuses ?? []
  const status = backendStatus.data?.agentBackendStatus
  const defaultBackendId = config.data?.selectedAgentBackend ?? "opencode"
  const defaultStatus =
    statuses.find((row) => row.backend.id === defaultBackendId) ?? status
  const unavailableStatuses = statuses.filter(
    (row) => row.kind === "UNAVAILABLE",
  )
  const backendKind = defaultStatus?.kind
  const blockingUnfinishedWorkItemCount =
    config.data?.blockingUnfinishedWorkItemCount ?? 0
  const unfinishedWorkItemCount = config.data?.unfinishedWorkItemCount ?? 0
  const backendChangeBlocked = blockingUnfinishedWorkItemCount > 0
  // Hydrate editable form fields once per dialog-open session. Live WI refresh
  // refetches config (counts) often; re-applying full config.data would wipe drafts.
  const formHydratedForOpenRef = useRef(false)

  useEffect(() => {
    if (!dialogOpen) {
      formHydratedForOpenRef.current = false
      return
    }
    if (!config.data || formHydratedForOpenRef.current) {
      return
    }
    formHydratedForOpenRef.current = true
    setSelectedAgentBackend(config.data.selectedAgentBackend)
    setDefaultModel(config.data.defaultModel ?? "")
    setDefaultVariant(config.data.defaultThinkingLevel ?? "")
    setReviewModel(config.data.reviewModel ?? "")
    setReviewVariant(config.data.reviewThinkingLevel ?? "")
    setMaxConcurrentOpencodeSessions(
      String(config.data.maxConcurrentAgentTurns),
    )
    setMaxConcurrentWorkItems(String(config.data.maxConcurrentWorkItems))
    previewGenerationRef.current += 1
    setPreviewModels(null)
    setPreviewError(null)
    setPreviewPending(false)
  }, [dialogOpen, config.data])

  const updateConfig = useMutation({
    mutationFn: (input: {
      selectedAgentBackend: string
      defaultModel: string | null
      defaultThinkingLevel: string | null
      reviewModel: string | null
      reviewThinkingLevel: string | null
      maxConcurrentAgentTurns: number
      maxConcurrentWorkItems: number
    }) =>
      graphql.mutation({
        updateConfig: {
          __args: { input },
          selectedAgentBackend: true,
          defaultModel: true,
          defaultThinkingLevel: true,
          reviewModel: true,
          reviewThinkingLevel: true,
          maxConcurrentAgentTurns: true,
          maxConcurrentWorkItems: true,
          unfinishedWorkItemCount: true,
          blockingUnfinishedWorkItemCount: true,
        },
      }),
    onSuccess: ({ updateConfig: updatedConfig }) => {
      queryClient.setQueryData(configQuery.queryKey, updatedConfig)
      void queryClient.invalidateQueries({
        queryKey: agentBackendStatusQuery.queryKey,
      })
      void queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey })
      // effectiveAgentBackend / blocking counts on Repository cards depend on
      // the harness default; refresh so inheriting repos do not stay stale.
      void queryClient.invalidateQueries({ queryKey: ["repositories"] })
      dialogRef.current?.close()
      setDialogOpen(false)
    },
  })

  const [recheckingBackendId, setRecheckingBackendId] = useState<string | null>(
    null,
  )
  const [recheckAllPending, setRecheckAllPending] = useState(false)
  const [recheckAllFailures, setRecheckAllFailures] = useState<
    readonly string[]
  >([])

  const recheckBackend = useMutation({
    mutationFn: async (backendId: string) => {
      setRecheckingBackendId(backendId)
      try {
        const result = await graphql.mutation({
          recheckAgentBackend: {
            __args: { backendId },
            ...agentBackendStatusSelection,
          },
        })
        return { backendId, status: result.recheckAgentBackend }
      } finally {
        setRecheckingBackendId(null)
      }
    },
    onSuccess: ({ backendId, status: rechecked }) => {
      type BackendStatusQueryData = {
        agentBackendStatuses: readonly AgentBackendStatusRow[]
        agentBackendStatus: AgentBackendStatusRow
        agentBackends: readonly { id: string; label: string }[]
      }
      queryClient.setQueryData<BackendStatusQueryData>(
        agentBackendStatusQuery.queryKey,
        (current) => {
          if (current == null) {
            return {
              agentBackendStatuses: [rechecked],
              agentBackendStatus: rechecked,
              agentBackends: [],
            }
          }
          const priorStatuses = current.agentBackendStatuses ?? []
          const nextStatuses = priorStatuses.some(
            (row) => row.backend.id === backendId,
          )
            ? priorStatuses.map((row) =>
                row.backend.id === backendId ? rechecked : row,
              )
            : [...priorStatuses, rechecked]
          const nextDefault =
            backendId ===
            (config.data?.selectedAgentBackend ?? defaultBackendId)
              ? rechecked
              : (current.agentBackendStatus ?? rechecked)
          return {
            ...current,
            agentBackendStatuses: nextStatuses,
            agentBackendStatus: nextDefault,
          }
        },
      )
      // Global models query is the harness-default catalog only.
      if (
        backendId === (config.data?.selectedAgentBackend ?? defaultBackendId)
      ) {
        void queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey })
      }
    },
  })

  const backendLabelForId = (backendId: string): string =>
    statuses.find((row) => row.backend.id === backendId)?.backend.label ??
    (backendStatus.data?.agentBackends ?? []).find(
      (backend) => backend.id === backendId,
    )?.label ??
    backendId

  const recheckAllBackends = async () => {
    const ids =
      statuses.length > 0
        ? statuses.map((row) => row.backend.id)
        : [defaultBackendId]
    setRecheckAllPending(true)
    setRecheckAllFailures([])
    recheckBackend.reset()
    const failedLabels: string[] = []
    try {
      // Continue after individual failures so other Active backends still refresh.
      for (const backendId of ids) {
        try {
          await recheckBackend.mutateAsync(backendId)
        } catch {
          failedLabels.push(backendLabelForId(backendId))
        }
      }
    } finally {
      setRecheckAllPending(false)
      setRecheckAllFailures(failedLabels)
    }
  }

  const applyModelPrefs = (prefs: {
    defaultModel: string | null
    defaultThinkingLevel: string | null
    reviewModel: string | null
    reviewThinkingLevel: string | null
  }) => {
    setDefaultModel(prefs.defaultModel ?? "")
    setDefaultVariant(prefs.defaultThinkingLevel ?? "")
    setReviewModel(prefs.reviewModel ?? "")
    setReviewVariant(prefs.reviewThinkingLevel ?? "")
  }

  const applyAgentBackendSelection = async (nextBackend: string) => {
    const generation = ++previewGenerationRef.current
    setSelectedAgentBackend(nextBackend)
    const savedAgentBackend = config.data?.selectedAgentBackend ?? "opencode"
    if (nextBackend === savedAgentBackend) {
      if (config.data) {
        applyModelPrefs({
          defaultModel: config.data.defaultModel,
          defaultThinkingLevel: config.data.defaultThinkingLevel,
          reviewModel: config.data.reviewModel,
          reviewThinkingLevel: config.data.reviewThinkingLevel,
        })
      }
      setPreviewModels(null)
      setPreviewError(null)
      setPreviewPending(false)
      return
    }

    setPreviewPending(true)
    setPreviewError(null)
    try {
      const [prefsResult, previewResult] = await Promise.all([
        graphql.query({
          harnessModelPrefs: {
            __args: { backendId: nextBackend },
            defaultModel: true,
            defaultThinkingLevel: true,
            reviewModel: true,
            reviewThinkingLevel: true,
          },
        }),
        graphql.query({
          previewAgentBackend: {
            __args: { backendId: nextBackend },
            backend: { id: true, label: true },
            kind: true,
            reason: true,
            models: { id: true, thinkingLevels: true },
          },
        }),
      ])
      // Ignore stale responses after a newer dropdown selection.
      if (generation !== previewGenerationRef.current) {
        return
      }
      applyModelPrefs(prefsResult.harnessModelPrefs)
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
  }

  const openSettings = () => {
    setDialogOpen(true)
    // Allow one hydrate for this open (effect or inline below).
    formHydratedForOpenRef.current = false
    // Discard any in-flight preview from a previous dialog session.
    previewGenerationRef.current += 1
    if (config.isError) {
      void config.refetch()
    }
    if (models.isError) {
      void models.refetch()
    }
    if (backendStatus.isError) {
      void backendStatus.refetch()
    }
    if (config.data) {
      formHydratedForOpenRef.current = true
      setSelectedAgentBackend(config.data.selectedAgentBackend)
      applyModelPrefs({
        defaultModel: config.data.defaultModel,
        defaultThinkingLevel: config.data.defaultThinkingLevel,
        reviewModel: config.data.reviewModel,
        reviewThinkingLevel: config.data.reviewThinkingLevel,
      })
      setMaxConcurrentOpencodeSessions(
        String(config.data.maxConcurrentAgentTurns),
      )
      setMaxConcurrentWorkItems(String(config.data.maxConcurrentWorkItems))
    }
    setPreviewModels(null)
    setPreviewError(null)
    setPreviewPending(false)
    setRecheckAllFailures([])
    updateConfig.reset()
    recheckBackend.reset()
    dialogRef.current?.showModal()
  }

  useEffect(() => {
    if (autoOpenAttempted || !config.isSuccess || buildConfigured) {
      return
    }
    setAutoOpenAttempted(true)
    setDialogOpen(true)
    updateConfig.reset()
    dialogRef.current?.showModal()
  }, [autoOpenAttempted, buildConfigured, config.isSuccess, updateConfig.reset])

  const savedAgentBackend = config.data?.selectedAgentBackend ?? "opencode"
  const backendChanging = selectedAgentBackend !== savedAgentBackend

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Live gate can flip while a draft backend change is staged; select may
    // already be disabled — still block submit (incl. Enter).
    if (backendChangeBlocked && selectedAgentBackend !== savedAgentBackend) {
      return
    }
    const parsedMaxSessions = Number(maxConcurrentAgentTurns)
    const parsedMaxWorkItems = Number(maxConcurrentWorkItems)
    updateConfig.mutate({
      selectedAgentBackend,
      defaultModel: defaultModel.trim() === "" ? null : defaultModel,
      defaultThinkingLevel:
        defaultThinkingLevel.trim() === "" ? null : defaultThinkingLevel,
      reviewModel: reviewModel.trim() === "" ? null : reviewModel,
      reviewThinkingLevel:
        reviewThinkingLevel.trim() === "" ? null : reviewThinkingLevel,
      maxConcurrentAgentTurns: parsedMaxSessions,
      maxConcurrentWorkItems: parsedMaxWorkItems,
    })
  }

  const catalogModels: readonly AgentModelOption[] | undefined = backendChanging
    ? (previewModels ?? undefined)
    : models.data
  const modelIds = (catalogModels ?? []).map((model) => model.id)
  const buildVariants = variantsForModel(catalogModels, defaultModel)
  const reviewThinkingLevelSourceModel =
    reviewModel.length > 0 ? reviewModel : defaultModel
  const reviewThinkingLevels = variantsForModel(
    catalogModels,
    reviewThinkingLevelSourceModel,
  )
  const hasUnavailableBuildModel =
    defaultModel.length > 0 && !modelIds.includes(defaultModel)
  const hasUnavailableReviewModel =
    reviewModel.length > 0 && !modelIds.includes(reviewModel)
  const hasCustomBuildVariant =
    defaultThinkingLevel.length > 0 &&
    (hasUnavailableBuildModel || !buildVariants.includes(defaultThinkingLevel))
  const hasCustomReviewVariant =
    reviewThinkingLevel.length > 0 &&
    (hasUnavailableReviewModel ||
      (reviewModel.length === 0 && hasUnavailableBuildModel) ||
      !reviewThinkingLevels.includes(reviewThinkingLevel))
  // First-run banner is about the harness default build model only; fully
  // configured Repository overrides are not hard-blocked by this guidance.
  const showUnconfiguredGuidance = config.isSuccess && !buildConfigured
  const showBackendBanner =
    config.isSuccess &&
    (backendKind === "UNAVAILABLE" || unavailableStatuses.length > 0)
  const bannerUnavailableReason =
    unavailableStatuses.length === 1
      ? `${unavailableStatuses[0]?.backend.label ?? "Agent Backend"}: ${
          unavailableStatuses[0]?.reason ?? "unavailable"
        }`
      : unavailableStatuses.length > 1
        ? `${unavailableStatuses.length} Agent Backends are unavailable`
        : (defaultStatus?.reason ?? "Agent Backend is unavailable")
  const modelsDisabled =
    backendChanging && (previewPending || previewError !== null)
  const modelsLoading =
    dialogOpen &&
    (backendChanging
      ? previewPending
      : models.isPending || backendStatus.isPending)
  const recheckBusy =
    recheckBackend.isPending ||
    recheckAllPending ||
    recheckingBackendId !== null

  return (
    <>
      {showBackendBanner && !dialogOpen && (
        <div
          className="mr-auto flex flex-wrap items-center gap-2 border border-oxblood/40 bg-oxblood-wash px-3 py-1.5 text-xs text-oxblood-deep sm:text-sm"
          role="status"
        >
          <span>{bannerUnavailableReason}</span>
          <button
            type="button"
            className="border border-oxblood/50 bg-paper px-2 py-0.5 text-xs font-semibold text-oxblood underline-offset-2 hover:bg-oxblood hover:text-paper"
            onClick={openSettings}
          >
            Open Settings
          </button>
        </div>
      )}
      {showUnconfiguredGuidance && !dialogOpen && !showBackendBanner && (
        <div
          className="mr-auto flex flex-wrap items-center gap-2 border border-oxblood/40 bg-oxblood-wash px-3 py-1.5 text-xs text-oxblood-deep sm:text-sm"
          role="status"
        >
          <span>Select a default build model first</span>
          <button
            type="button"
            className="border border-oxblood/50 bg-paper px-2 py-0.5 text-xs font-semibold text-oxblood underline-offset-2 hover:bg-oxblood hover:text-paper"
            onClick={openSettings}
          >
            Open Settings
          </button>
        </div>
      )}
      {/* Home / Repos / Kanban / Settings share one right-aligned control cluster.
          Status banners above stay nav-level siblings (outside the cluster). */}
      <div className="ml-auto flex items-center gap-2 self-center">
        {leading}
        <button
          type="button"
          className={primaryNavActionClassName}
          onClick={openSettings}
          aria-haspopup="dialog"
        >
          <svg
            aria-hidden="true"
            className="size-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.57 15 1.7 1.7 0 0 0 3 14H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.57 1.7 1.7 0 0 0 10 3V3h4v.08A1.7 1.7 0 0 0 15.06 4.6a1.7 1.7 0 0 0 1.88-.34L17 4.2 19.83 7l-.06.06A1.7 1.7 0 0 0 19.43 9 1.7 1.7 0 0 0 21 10h.08v4H21a1.7 1.7 0 0 0-1.6 1Z" />
          </svg>
          Settings
        </button>
      </div>

      <dialog
        ref={dialogRef}
        className="m-auto w-[min(92vw,32rem)] border border-rule-2 bg-panel p-0 text-ink shadow-[0_18px_50px_rgb(28_22_14_/_18%)] backdrop:bg-ink/45"
        aria-labelledby="settings-title"
        onCancel={(event) => {
          if (updateConfig.isPending) event.preventDefault()
        }}
        onClose={() => setDialogOpen(false)}
      >
        <form onSubmit={saveSettings}>
          <div className="border-b border-rule px-6 py-5">
            <p className="font-mono text-xs font-semibold tracking-[0.22em] text-oxblood uppercase">
              Harness defaults
            </p>
            <h2
              id="settings-title"
              className="mt-1.5 font-serif text-2xl font-semibold tracking-[-0.01em]"
            >
              Harness settings
            </h2>
            <p className="mt-1.5 text-sm text-ink-soft">
              Defaults for agent sessions and Agent Turn concurrency.
            </p>
            {showUnconfiguredGuidance && (
              <p className="mt-3 border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                Select a default agent backend, and default build model.
                Optionally select a different review model (recommended). You
                can override this per configured repo.
              </p>
            )}
            {!backendChanging &&
              (unavailableStatuses.length > 0 ||
                (unavailableStatuses.length === 0 &&
                  defaultStatus?.kind === "UNAVAILABLE")) && (
                <div className="mt-3 grid gap-2">
                  {(unavailableStatuses.length > 0
                    ? unavailableStatuses
                    : defaultStatus !== undefined
                      ? [defaultStatus as AgentBackendStatusRow]
                      : []
                  ).map((row) => (
                    <p
                      key={row.backend.id}
                      className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep"
                    >
                      <span className="font-semibold">{row.backend.label}</span>
                      {": "}
                      {row.reason ?? "Agent Backend is unavailable."}
                    </p>
                  ))}
                </div>
              )}
          </div>

          <div className="grid gap-5 px-6 py-5">
            {config.isPending || modelsLoading ? (
              <p className="text-sm text-ink-soft">Loading settings...</p>
            ) : config.isError ||
              (!backendChanging &&
                (models.isError || backendStatus.isError)) ? (
              <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                Settings could not be loaded. Close this dialog and try again.
              </p>
            ) : (
              <>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Default Agent Backend
                  <select
                    className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15 disabled:cursor-not-allowed disabled:opacity-60"
                    name="selectedAgentBackend"
                    value={selectedAgentBackend}
                    disabled={backendChangeBlocked || updateConfig.isPending}
                    onChange={(event) => {
                      void applyAgentBackendSelection(event.target.value)
                    }}
                  >
                    {(backendStatus.data?.agentBackends ?? []).map(
                      (backend) => (
                        <option key={backend.id} value={backend.id}>
                          {backend.label}
                        </option>
                      ),
                    )}
                  </select>
                  <span className="text-xs font-normal text-ink-faint">
                    {backendChangeBlocked
                      ? `${blockingUnfinishedWorkItemCount} unfinished Work Item${
                          blockingUnfinishedWorkItemCount === 1 ? "" : "s"
                        } on Repositories inheriting the harness default — finish or abandon them before changing the default Agent Backend.${
                          unfinishedWorkItemCount >
                          blockingUnfinishedWorkItemCount
                            ? ` (${unfinishedWorkItemCount} unfinished fleet-wide.)`
                            : ""
                        }`
                      : "Activates immediately on Save when no inheriting Work Items are unfinished. Model prefs are remembered per backend. Repository overrides are independent."}
                  </span>
                </label>

                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="m-0 text-xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
                      Active Agent Backends
                    </p>
                    <button
                      type="button"
                      className="border border-rule-2 bg-paper px-2 py-1 text-xs font-semibold text-ink-2 hover:bg-paper-2 disabled:opacity-50"
                      disabled={recheckBusy || backendChanging}
                      onClick={() => {
                        void recheckAllBackends()
                      }}
                    >
                      {recheckAllPending ? "Rechecking all…" : "Recheck all"}
                    </button>
                  </div>
                  {(statuses.length > 0
                    ? statuses
                    : defaultStatus !== undefined
                      ? [defaultStatus as AgentBackendStatusRow]
                      : []
                  ).map((row) => {
                    const isDefault = row.backend.id === savedAgentBackend
                    const rowRechecking = recheckingBackendId === row.backend.id
                    return (
                      <div
                        key={row.backend.id}
                        className="flex flex-wrap items-center justify-between gap-2 border border-rule bg-paper-2 px-3 py-2"
                      >
                        <p className="m-0 text-xs text-ink-soft">
                          <span className="font-semibold text-ink-2">
                            {row.backend.label}
                          </span>
                          {isDefault ? " · Default" : null}
                          {row.kind === "READY" ? " · Ready" : " · Unavailable"}
                          {backendChanging &&
                          row.backend.id === selectedAgentBackend
                            ? " · Previewing selection"
                            : null}
                          {row.kind === "UNAVAILABLE" && row.reason !== null
                            ? ` — ${row.reason}`
                            : null}
                        </p>
                        <button
                          type="button"
                          className="border border-rule-2 bg-paper px-2 py-1 text-xs font-semibold text-ink-2 hover:bg-paper-2 disabled:opacity-50"
                          disabled={recheckBusy || backendChanging}
                          onClick={() => {
                            setRecheckAllFailures([])
                            recheckBackend.mutate(row.backend.id)
                          }}
                        >
                          {rowRechecking
                            ? "Rechecking…"
                            : `Recheck ${row.backend.label}`}
                        </button>
                      </div>
                    )
                  })}
                  {statuses.length === 0 && defaultStatus === undefined && (
                    <p className="m-0 text-xs text-ink-soft">
                      No Active Agent Backend status yet.
                    </p>
                  )}
                </div>

                {backendChanging && previewError !== null && (
                  <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                    Preview failed: {previewError}. Model fields stay disabled
                    until preview succeeds. Active backend is unchanged until
                    Save.
                  </p>
                )}

                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Build model
                  <select
                    className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 font-mono text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15 disabled:cursor-not-allowed disabled:opacity-60"
                    name="defaultModel"
                    value={defaultModel}
                    onChange={(event) => {
                      const nextModel = event.target.value
                      setDefaultModel(nextModel)
                      const nextVariants = variantsForModel(
                        catalogModels,
                        nextModel,
                      )
                      setDefaultVariant((current) =>
                        reconcileVariantForModel(current, nextVariants),
                      )
                      if (reviewModel.length === 0) {
                        setReviewVariant((current) =>
                          reconcileVariantForModel(current, nextVariants),
                        )
                      }
                    }}
                    required={!backendChanging}
                    disabled={modelsDisabled}
                  >
                    {defaultModel.length === 0 && (
                      <option value="">
                        {previewPending
                          ? "Loading catalog…"
                          : "Select a build model"}
                      </option>
                    )}
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
                  <span className="text-xs font-normal text-ink-faint">
                    Used for implement and other build steps.
                  </span>
                </label>

                {defaultModel.length > 0 && hasUnavailableBuildModel ? (
                  <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                    Build effort (thinking) is unavailable — the selected model
                    is not in the Agent Model catalog. Choose another build
                    model.
                  </p>
                ) : defaultModel.length > 0 && buildVariants.length === 0 ? (
                  <p className="bg-paper-2 p-3 text-sm text-ink-soft">
                    Build effort (thinking) is unavailable — this model has no
                    effort (thinking) options.
                  </p>
                ) : (
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                    Build effort (thinking)
                    <select
                      className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15 disabled:cursor-not-allowed disabled:opacity-60"
                      name="defaultThinkingLevel"
                      value={defaultThinkingLevel}
                      onChange={(event) =>
                        setDefaultVariant(event.target.value)
                      }
                      disabled={modelsDisabled || defaultModel.length === 0}
                    >
                      <option value="">
                        {buildVariants.length === 0
                          ? "Model default (no effort (thinking) options)"
                          : "Model default"}
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
                    <span className="text-xs font-normal text-ink-faint">
                      Optional effort (thinking) for this model. Options come
                      from the selected model.
                    </span>
                  </label>
                )}

                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Review model
                  <select
                    className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 font-mono text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15 disabled:cursor-not-allowed disabled:opacity-60"
                    name="reviewModel"
                    value={reviewModel}
                    disabled={modelsDisabled}
                    onChange={(event) => {
                      const nextModel = event.target.value
                      setReviewModel(nextModel)
                      const nextVariants = variantsForModel(
                        catalogModels,
                        nextModel.length > 0 ? nextModel : defaultModel,
                      )
                      setReviewVariant((current) =>
                        reconcileVariantForModel(current, nextVariants),
                      )
                    }}
                  >
                    <option value="">Same as build model</option>
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
                  <span className="text-xs font-normal text-ink-faint">
                    Used only for the review step. Empty uses the build model.
                  </span>
                </label>

                {reviewThinkingLevelSourceModel.length > 0 &&
                ((reviewModel.length > 0 && hasUnavailableReviewModel) ||
                  (reviewModel.length === 0 && hasUnavailableBuildModel)) ? (
                  <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                    Review effort (thinking) is unavailable — the selected model
                    is not in the Agent Model catalog. Choose another model or
                    use the build model.
                  </p>
                ) : reviewThinkingLevelSourceModel.length > 0 &&
                  reviewThinkingLevels.length === 0 ? (
                  <p className="bg-paper-2 p-3 text-sm text-ink-soft">
                    Review effort (thinking) is unavailable — this model has no
                    effort (thinking) options.
                  </p>
                ) : (
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                    Review effort (thinking)
                    <select
                      className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15 disabled:cursor-not-allowed disabled:opacity-60"
                      name="reviewThinkingLevel"
                      value={reviewThinkingLevel}
                      onChange={(event) => setReviewVariant(event.target.value)}
                      disabled={
                        modelsDisabled ||
                        reviewThinkingLevelSourceModel.length === 0 ||
                        reviewThinkingLevels.length === 0
                      }
                    >
                      <option value="">Same as build effort (thinking)</option>
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

                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Max concurrent Agent Turns
                  <input
                    className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15"
                    name="maxConcurrentAgentTurns"
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={maxConcurrentAgentTurns}
                    onChange={(event) =>
                      setMaxConcurrentOpencodeSessions(event.target.value)
                    }
                  />
                  <span className="text-xs font-normal text-ink-faint">
                    Caps how many Agent Turn CLI processes run at once (default
                    2). Agent-free steps and model listing are not counted.
                  </span>
                </label>

                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Max concurrent Work Items
                  <input
                    className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15"
                    name="maxConcurrentWorkItems"
                    type="number"
                    min={1}
                    step={1}
                    required
                    value={maxConcurrentWorkItems}
                    onChange={(event) =>
                      setMaxConcurrentWorkItems(event.target.value)
                    }
                  />
                  <span className="text-xs font-normal text-ink-faint">
                    Caps how many Work Items may be Admitted at once (Worker
                    Slots, default 5). Extra Implement requests wait for a free
                    slot.
                  </span>
                </label>
              </>
            )}

            {updateConfig.isError && (
              <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                {updateConfig.error instanceof Error
                  ? updateConfig.error.message
                  : "Settings could not be saved. Check the values and try again."}
              </p>
            )}
            {recheckAllFailures.length > 0 && (
              <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                Recheck failed for{" "}
                {recheckAllFailures.length === 1
                  ? recheckAllFailures[0]
                  : recheckAllFailures.join(", ")}
                . Other backends may have refreshed. Try again after fixing
                those Agent Backends.
              </p>
            )}
            {recheckAllFailures.length === 0 && recheckBackend.isError && (
              <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                Recheck failed
                {recheckBackend.variables !== undefined
                  ? ` for ${backendLabelForId(recheckBackend.variables)}`
                  : ""}
                . Try again after fixing that Agent Backend.
              </p>
            )}
          </div>

          <div className="flex justify-end gap-3 border-t border-rule bg-paper-2 px-6 py-4">
            <button
              type="button"
              className="border border-rule-2 px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-paper"
              onClick={() => {
                dialogRef.current?.close()
                setDialogOpen(false)
              }}
              disabled={updateConfig.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="bg-oxblood px-4 py-2 text-sm font-semibold tracking-wide text-paper uppercase hover:bg-oxblood-deep disabled:cursor-not-allowed disabled:opacity-50"
              disabled={
                config.isPending ||
                config.isError ||
                modelsLoading ||
                updateConfig.isPending ||
                (backendChangeBlocked && backendChanging) ||
                (backendChanging && previewError !== null) ||
                // Empty build model allowed on backend change (first-run style);
                // non-empty must still be in the preview/active catalog.
                (defaultModel.length > 0 && hasUnavailableBuildModel) ||
                (!backendChanging && defaultModel.length === 0)
              }
            >
              {updateConfig.isPending ? "Saving..." : "Save settings"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
