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
  retainSearchParams,
  useNavigate,
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
import { Banner, BannerActionButton } from "../banner.js"
import { CommittedPullRequestsDashboard } from "../committed-pr-dashboard.js"
import { READY_FOR_AGENT_VERSION_LABEL } from "../generated/version"
import { JobsRepositoryFilterProvider } from "../jobs-repository-filter.js"
import { JobsViewSwitcher } from "../jobs-view-switcher.js"
import { repositoriesQuery } from "../repositories-query.js"
import appCss from "../styles.css?url"
import {
  THEME_BOOTSTRAP_SCRIPT,
  type ThemeMode,
  applyThemeMode,
  oppositeTheme,
  parseThemeSearch,
  readDocumentTheme,
  themeToggleLabel,
  withThemePin,
} from "../theme.js"
import { cx, ui } from "../ui.js"

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

const FONT_STYLESHEET_HREF =
  "https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap"

export const Route = createRootRouteWithContext<RouterContext>()({
  // Theme pin is a shareable root search param; retain it on all SPA navigations
  // so bootstrap still sees `?theme=` after Home/Repos/Completed + full reload.
  validateSearch: (raw: Record<string, unknown>) => parseThemeSearch(raw),
  search: {
    middlewares: [retainSearchParams(["theme"])],
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1.0",
      },
      { title: "Ready for Agent" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      { rel: "stylesheet", href: FONT_STYLESHEET_HREF },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <div className={ui.notFoundPanel}>
      <p>Page not found.</p>
      <Link
        className="mt-2 inline-block text-ink underline decoration-signal underline-offset-4 hover:text-ink-dim"
        to="/"
      >
        Back home
      </Link>
    </div>
  ),
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          // Theme before paint: prefers-color-scheme default, ?theme= pin.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static bootstrap only
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body className="min-h-screen min-w-80 bg-paper font-display text-ink antialiased [font-synthesis:none] [text-rendering:optimizeLegibility]">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

/** Stamped-plate base for primary nav controls (active via aria-current). */
const mastPlateClassName = ui.mastPlate

function SettingsNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.57 15 1.7 1.7 0 0 0 3 14H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.57 1.7 1.7 0 0 0 10 3V3h4v.08A1.7 1.7 0 0 0 15.06 4.6a1.7 1.7 0 0 0 1.88-.34L17 4.2 19.83 7l-.06.06A1.7 1.7 0 0 0 19.43 9 1.7 1.7 0 0 0 21 10h.08v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </svg>
  )
}

function RootComponent() {
  // Chrome (masthead + lane ribbon + merged-PR dashboard) is full-bleed and
  // sticky on every route so nav and throughput never jump. Repos caps reading
  // width on page body only.
  return (
    <div className="min-h-screen w-full">
      <SettingsChrome />
      <ReactQueryDevtools buttonPosition="bottom-left" />
      <TanStackRouterDevtools position="bottom-right" />
    </div>
  )
}

function ThemeTogglePlate() {
  // SSR-stable initial state: server and first client paint match ("light"
  // control chrome). Page colors already follow bootstrap's data-theme; the
  // mount effect below mirrors that onto the plate without a hydration mismatch.
  const [theme, setTheme] = useState<ThemeMode>("light")
  // No `from: Route.fullPath` — that roots relative nav at `/` and would send
  // Repos/Completed operators home when only search should change.
  const navigate = useNavigate()

  useEffect(() => {
    // Sync only — do not re-resolve/re-apply (would race a pre-effect toggle).
    setTheme(readDocumentTheme())
  }, [])

  const targetLabel = themeToggleLabel(theme)

  return (
    <button
      type="button"
      className={mastPlateClassName}
      aria-label={`Switch to ${targetLabel} theme`}
      aria-pressed={theme === "dark"}
      onClick={() => {
        const next = oppositeTheme(readDocumentTheme())
        applyThemeMode(next)
        // Stay on the current leaf route; only pin ?theme= for bootstrap/retain.
        void navigate({
          to: ".",
          search: (prev) => withThemePin(prev, next),
          replace: true,
          resetScroll: false,
        })
        setTheme(next)
      }}
    >
      <ThemeMoonIcon />
      <span>{targetLabel}</span>
    </button>
  )
}

function ThemeMoonIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
    </svg>
  )
}

function SettingsChrome() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [autoOpenAttempted, setAutoOpenAttempted] = useState(false)
  const config = useQuery(configQuery)
  const backendStatus = useQuery(agentBackendStatusQuery)
  // Do not treat pending/unknown as empty: hide the band only once membership
  // has loaded with zero repositories (matches HomeContent blank-slate gate).
  const repositoriesMembership = useQuery(repositoriesQuery)
  const showCommittedPullRequestsBand =
    !repositoriesMembership.isSuccess || repositoriesMembership.data.length > 0
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
    <JobsRepositoryFilterProvider>
      <div className={ui.appChrome}>
        <header className={ui.mast}>
          <div>
            <p className={ui.brandKicker}>
              <b
                className={ui.brandKickerB}
                title={`Ready for Agent ${READY_FOR_AGENT_VERSION_LABEL}`}
              >
                RFA {READY_FOR_AGENT_VERSION_LABEL}
              </b>
            </p>
            <h1 className={ui.brandWordmark}>
              <Link
                to="/"
                activeOptions={{ exact: true }}
                className={ui.brandWordmarkLink}
              >
                Ready for Agent
              </Link>
            </h1>
            <p className={ui.brandSub}>
              <span className={ui.brandSubOk}>Clanker Harness</span>
            </p>
          </div>
          <nav className={ui.mastNav} aria-label="Primary">
            <ThemeTogglePlate />
            <button
              type="button"
              className={mastPlateClassName}
              onClick={openSettings}
              aria-haspopup="dialog"
            >
              <SettingsNavIcon />
              Settings
            </button>
          </nav>
        </header>
        <div className={ui.laneRibbon} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        {/* Throughput band belongs with the board, not the zero-repo blank slate. */}
        {showCommittedPullRequestsBand ? (
          <section
            className={ui.mergedPrStatsBand}
            aria-label="Committed pull requests"
          >
            <CommittedPullRequestsDashboard />
          </section>
        ) : null}
        <JobsViewSwitcher />
      </div>

      <div className={ui.pageShell}>
        {showBackendBanner && !dialogOpen && (
          <Banner
            tone="alarm"
            tag="Backend"
            action={
              <BannerActionButton onClick={openSettings}>
                Open Settings
              </BannerActionButton>
            }
          >
            {bannerUnavailableReason}
          </Banner>
        )}
        {showUnconfiguredGuidance && !dialogOpen && !showBackendBanner && (
          <Banner
            tone="guidance"
            tag="Setup"
            action={
              <BannerActionButton onClick={openSettings}>
                Open Settings
              </BannerActionButton>
            }
          >
            Select a default build model first
          </Banner>
        )}
        <Outlet />
      </div>

      <dialog
        ref={dialogRef}
        className={ui.dialogPanel}
        aria-labelledby="settings-title"
        onCancel={(event) => {
          if (updateConfig.isPending) event.preventDefault()
        }}
        onClose={() => setDialogOpen(false)}
      >
        <form onSubmit={saveSettings}>
          <div className={ui.dialogHeader}>
            <p className={ui.dialogKicker}>Harness defaults</p>
            <h2 id="settings-title" className={ui.dialogTitle}>
              Harness settings
            </h2>
            <p className={ui.dialogLede}>
              Defaults for agent sessions and Agent Turn concurrency.
            </p>
            {showUnconfiguredGuidance && (
              <Banner
                className={cx(ui.bannerCompact, "mt-3")}
                tone="guidance"
                tag="Setup"
              >
                Select a default agent backend, and default build model.
                Optionally select a different review model (recommended). You
                can override this per configured repo.
              </Banner>
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
                    <Banner
                      key={row.backend.id}
                      className={ui.bannerCompact}
                      tone="alarm"
                      tag="Backend"
                      role="alert"
                    >
                      <span className="font-semibold">{row.backend.label}</span>
                      {": "}
                      {row.reason ?? "Agent Backend is unavailable."}
                    </Banner>
                  ))}
                </div>
              )}
          </div>

          <div className={ui.dialogBody}>
            {config.isPending || modelsLoading ? (
              <p className={ui.dialogLoading}>Loading settings...</p>
            ) : config.isError ||
              (!backendChanging &&
                (models.isError || backendStatus.isError)) ? (
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Error"
                role="alert"
              >
                Settings could not be loaded. Close this dialog and try again.
              </Banner>
            ) : (
              <>
                <label className={ui.dialogField}>
                  Default Agent Backend
                  <select
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
                  <span className={ui.dialogFieldHint}>
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

                <div className={ui.dialogStatusBlock}>
                  <div className={ui.dialogStatusHead}>
                    <p className={ui.dialogStatusLabel}>
                      Active Agent Backends
                    </p>
                    <button
                      type="button"
                      className={ui.plateMini}
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
                      <div key={row.backend.id} className={ui.dialogStatusRow}>
                        <p className="m-0">
                          <strong>{row.backend.label}</strong>
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
                          className={ui.plateMini}
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
                    <p className={ui.dialogLoading}>
                      No Active Agent Backend status yet.
                    </p>
                  )}
                </div>

                {backendChanging && previewError !== null && (
                  <Banner
                    className={ui.bannerCompact}
                    tone="alarm"
                    tag="Preview"
                    role="alert"
                  >
                    Preview failed: {previewError}. Model fields stay disabled
                    until preview succeeds. Active backend is unchanged until
                    Save.
                  </Banner>
                )}

                <label className={cx(ui.dialogField, ui.dialogFieldMono)}>
                  Build model
                  <select
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
                  <span className={ui.dialogFieldHint}>
                    Used for implement and other build steps.
                  </span>
                </label>

                {defaultModel.length > 0 && hasUnavailableBuildModel ? (
                  <Banner
                    className={ui.bannerCompact}
                    tone="alarm"
                    tag="Model"
                    role="alert"
                  >
                    Build effort (thinking) is unavailable — the selected model
                    is not in the Agent Model catalog. Choose another build
                    model.
                  </Banner>
                ) : defaultModel.length > 0 && buildVariants.length === 0 ? (
                  <p className={ui.dialogNote}>
                    Build effort (thinking) is unavailable — this model has no
                    effort (thinking) options.
                  </p>
                ) : (
                  <label className={ui.dialogField}>
                    Build effort (thinking)
                    <select
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
                    <span className={ui.dialogFieldHint}>
                      Optional effort (thinking) for this model. Options come
                      from the selected model.
                    </span>
                  </label>
                )}

                <label className={cx(ui.dialogField, ui.dialogFieldMono)}>
                  Review model
                  <select
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
                  <span className={ui.dialogFieldHint}>
                    Used only for the review step. Empty uses the build model.
                  </span>
                </label>

                {reviewThinkingLevelSourceModel.length > 0 &&
                ((reviewModel.length > 0 && hasUnavailableReviewModel) ||
                  (reviewModel.length === 0 && hasUnavailableBuildModel)) ? (
                  <Banner
                    className={ui.bannerCompact}
                    tone="alarm"
                    tag="Model"
                    role="alert"
                  >
                    Review effort (thinking) is unavailable — the selected model
                    is not in the Agent Model catalog. Choose another model or
                    use the build model.
                  </Banner>
                ) : reviewThinkingLevelSourceModel.length > 0 &&
                  reviewThinkingLevels.length === 0 ? (
                  <p className={ui.dialogNote}>
                    Review effort (thinking) is unavailable — this model has no
                    effort (thinking) options.
                  </p>
                ) : (
                  <label className={ui.dialogField}>
                    Review effort (thinking)
                    <select
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

                <label className={ui.dialogField}>
                  Max concurrent Agent Turns
                  <input
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
                  <span className={ui.dialogFieldHint}>
                    Caps how many Agent Turn CLI processes run at once (default
                    2). Agent-free steps and model listing are not counted.
                  </span>
                </label>

                <label className={ui.dialogField}>
                  Max concurrent Work Items
                  <input
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
                  <span className={ui.dialogFieldHint}>
                    Caps how many Work Items may be Admitted at once (Worker
                    Slots, default 5). Extra Implement requests wait for a free
                    slot.
                  </span>
                </label>
              </>
            )}

            {updateConfig.isError && (
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Error"
                role="alert"
              >
                {updateConfig.error instanceof Error
                  ? updateConfig.error.message
                  : "Settings could not be saved. Check the values and try again."}
              </Banner>
            )}
            {recheckAllFailures.length > 0 && (
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Recheck"
                role="alert"
              >
                Recheck failed for{" "}
                {recheckAllFailures.length === 1
                  ? recheckAllFailures[0]
                  : recheckAllFailures.join(", ")}
                . Other backends may have refreshed. Try again after fixing
                those Agent Backends.
              </Banner>
            )}
            {recheckAllFailures.length === 0 && recheckBackend.isError && (
              <Banner
                className={ui.bannerCompact}
                tone="alarm"
                tag="Recheck"
                role="alert"
              >
                Recheck failed
                {recheckBackend.variables !== undefined
                  ? ` for ${backendLabelForId(recheckBackend.variables)}`
                  : ""}
                . Try again after fixing that Agent Backend.
              </Banner>
            )}
          </div>

          <div className={ui.dialogFooter}>
            <button
              type="button"
              className={ui.plateMini}
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
              className={ui.platePrimary}
              aria-busy={updateConfig.isPending || undefined}
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
              {updateConfig.isPending ? "Saving…" : "Save settings"}
            </button>
          </div>
        </form>
      </dialog>
    </JobsRepositoryFilterProvider>
  )
}
