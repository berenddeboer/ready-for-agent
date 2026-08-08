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
  useBlocker,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools"
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { createClient } from "@ready-for-agent/graphql-client"
import { formatAgentBackendStatusTrail } from "../agent-backend-status-label.js"
import { AgentBackendWarnings } from "../agent-backend-warnings.js"
import { AgentModelSelect } from "../agent-model-select.js"
import {
  type AgentModelOption,
  CLAUDE_AGENT_BACKEND_ID,
  agentModelSaveBlockReason,
  blocksAgentModelSave,
  formatUnavailableVariantLabel,
  formatVariantLabel,
  isClaudeBedrockConfigurationMode,
  isUnavailableCatalogModel,
  reconcileVariantForModel,
  thinkingLevelsForModel,
} from "../agent-model-settings.js"
import { Banner, BannerActionButton } from "../banner.js"
import { CommittedPullRequestsDashboard } from "../committed-pr-dashboard.js"
import { READY_FOR_AGENT_VERSION_LABEL } from "../generated/version"
import { GitHubThrottleBanner } from "../github-throttle-banner.js"
import { getHarnessSettingsAutoOpenAction } from "../harness-settings-auto-open.js"
import { JobsRepositoryFilterProvider } from "../jobs-repository-filter.js"
import { JobsViewSwitcher } from "../jobs-view-switcher.js"
import { MastheadScrollwork } from "../masthead-scrollwork.js"
import { repositoriesQuery } from "../repositories-query.js"
import {
  isHarnessSettingsPath,
  isOtherRoutedDialogPath,
  isSessionTelemetryPath,
  parseSessionTelemetryPath,
  readHarnessSettingsHistoryState,
  readSessionTelemetryHistoryState,
  wasSessionTelemetryOpenedFromInApp,
} from "../routed-dialog.js"
import { SessionUsageDialog } from "../session-usage-dialog.js"
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
  models: { id: true, thinkingLevels: true, name: true, kind: true },
  provider: { id: true, label: true },
  warnings: true,
} as const

const agentBackendStatusQuery = {
  queryKey: ["agentBackendStatus"],
  queryFn: async () => {
    const result = await graphql.query({
      agentBackendStatuses: agentBackendStatusSelection,
      // Legacy singular surface for the harness default (derived server-side).
      agentBackendStatus: agentBackendStatusSelection,
      agentBackends: { id: true, label: true, configurationMode: true },
    })
    return result
  },
}

const githubThrottleStatusQuery = {
  queryKey: ["githubThrottleStatus"],
  refetchInterval: 1_000,
  queryFn: async () => {
    const result = await graphql.query({
      githubThrottleStatus: { retryAt: true },
    })
    return result.githubThrottleStatus
  },
}

type AgentBackendListEntry = {
  id: string
  label: string
  configurationMode: string | null
}

type AgentBackendStatusRow = {
  backend: { id: string; label: string }
  selectedBackend: { id: string; label: string }
  activeBackend: { id: string; label: string }
  kind: "READY" | "UNAVAILABLE"
  reason: string | null
  models: readonly AgentModelOption[]
  provider: { id: string; label: string } | null
  warnings: readonly string[]
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

/** Hub icon inside the Settings cog core (prototype B sunburst). */
function SettingsNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

/**
 * Solid brass gear silhouette for Settings (prototype B).
 * True gear path — not a conic-gradient pie (that never grows teeth).
 * 12 teeth, hub hole covered by `.core`. Path is static (viewBox 0 0 64 64).
 */
const SETTINGS_COG_TEETH_PATH =
  "M 26.00 9.59 L 29.82 8.90 L 29.18 2.13 L 34.82 2.13 L 34.18 8.90 L 38.00 9.59 L 41.66 10.91 L 44.49 4.72 L 49.38 7.55 L 45.44 13.09 L 48.40 15.60 L 50.91 18.56 L 56.45 14.62 L 59.28 19.51 L 53.09 22.34 L 54.41 26.00 L 55.10 29.82 L 61.87 29.18 L 61.87 34.82 L 55.10 34.18 L 54.41 38.00 L 53.09 41.66 L 59.28 44.49 L 56.45 49.38 L 50.91 45.44 L 48.40 48.40 L 45.44 50.91 L 49.38 56.45 L 44.49 59.28 L 41.66 53.09 L 38.00 54.41 L 34.18 55.10 L 34.82 61.87 L 29.18 61.87 L 29.82 55.10 L 26.00 54.41 L 22.34 53.09 L 19.51 59.28 L 14.62 56.45 L 18.56 50.91 L 15.60 48.40 L 13.09 45.44 L 7.55 49.38 L 4.72 44.49 L 10.91 41.66 L 9.59 38.00 L 8.90 34.18 L 2.13 34.82 L 2.13 29.18 L 8.90 29.82 L 9.59 26.00 L 10.91 22.34 L 4.72 19.51 L 7.55 14.62 L 13.09 18.56 L 15.60 15.60 L 18.56 13.09 L 14.62 7.55 L 19.51 4.72 L 22.34 10.91 L 26.00 9.59 Z M 45.50 32.00 A 13.5 13.5 0 1 0 18.50 32.00 A 13.5 13.5 0 1 0 45.50 32.00 Z"

function SettingsCogTeeth() {
  return (
    <svg
      className="teeth"
      aria-hidden="true"
      viewBox="0 0 64 64"
      fill="currentColor"
    >
      <path d={SETTINGS_COG_TEETH_PATH} fillRule="evenodd" />
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
      {/* Route-driven Session Telemetry overlay (issues #841 / #843); one root
          instance so Pipeline/Repos/Completed open, Back/Forward, and direct
          loads share ownership. */}
      <SessionTelemetryOverlay />
      <ReactQueryDevtools buttonPosition="bottom-left" />
      <TanStackRouterDevtools position="bottom-right" />
    </div>
  )
}

/**
 * Session Telemetry at `/session/<work-item-id>/telemetry` (ADR 0048 / #841 / #843 / #906).
 * In-app opens mask the retained runtime surface; direct entry uses the
 * canonical Pipeline route. Close/Escape/Back leave the public overlay URL.
 */
function SessionTelemetryOverlay() {
  const navigate = useNavigate()
  const router = useRouter()
  const telemetryPathname = useRouterState({
    select: (s) => s.location.maskedLocation?.pathname ?? s.location.pathname,
  })
  const telemetryHistoryState = useRouterState({
    select: (s) => readSessionTelemetryHistoryState(s.location.state),
  })
  const parsed = parseSessionTelemetryPath(telemetryPathname)
  const workItemId = parsed?.workItemId ?? null
  const open = workItemId !== null
  const sessionIdHint = telemetryHistoryState?.sessionId ?? null

  const leaveSessionTelemetryRoute = () => {
    // Require both history marker and same-document flag so a full reload
    // (which restores history state) still uses replace → `/`.
    const openedFromInApp =
      wasSessionTelemetryOpenedFromInApp() &&
      telemetryHistoryState?.kind === "in-app-origin"
    if (openedFromInApp && router.history.canGoBack()) {
      router.history.back()
      return
    }
    void navigate({
      to: "/",
      search: (prev) => prev,
      replace: true,
    })
  }

  return (
    <SessionUsageDialog
      workItemId={workItemId}
      sessionId={sessionIdHint}
      open={open}
      onClose={() => {
        // Native dialog already closed; leave the route only when we are still
        // on the telemetry path (Back already changed location first).
        if (isSessionTelemetryPath(telemetryPathname)) {
          leaveSessionTelemetryRoute()
        }
      }}
    />
  )
}

/**
 * Switchboard lever for light/dark — exact DOM/CSS of prototype C (.c-lever).
 * Lever up = light; down = dark. Visible label is the *target* theme.
 */
function ThemeTogglePlate() {
  // SSR-stable initial state: server and first client paint match ("light"
  // control chrome). Page colors already follow bootstrap's data-theme; the
  // mount effect below mirrors that onto the lever without a hydration mismatch.
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
      className={ui.mastThemeLever}
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
      <span className="cradle">
        <span className="slot" aria-hidden="true" />
        <span className="stem" aria-hidden="true" />
        <span className="handle" aria-hidden="true" />
      </span>
      <span className="tag">{targetLabel}</span>
    </button>
  )
}

function SettingsChrome() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const router = useRouter()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const settingsHistoryState = useRouterState({
    select: (s) => readHarnessSettingsHistoryState(s.location.state),
  })
  // Routed `/settings` open (explicit / direct / forward). First-run stays
  // local-only and never pushes this path (issue #840).
  const routedSettingsOpen = isHarnessSettingsPath(pathname)
  const [localSettingsOpen, setLocalSettingsOpen] = useState(false)
  const dialogOpen = routedSettingsOpen || localSettingsOpen
  // Prevent onClose from double-navigating when we close as part of leaveRoute.
  const dismissingRouteRef = useRef(false)
  // True only after an explicit in-app open in this SPA document session.
  // History state alone is not enough: HTML5 restores state across full reload,
  // but refresh/direct entry must still close with replace → `/` (issue #840).
  const settingsOpenedFromInAppThisSessionRef = useRef(false)
  // Coalesce rapid masthead clicks before the first `/settings` navigate commits.
  const settingsOpenNavigatePendingRef = useRef(false)
  // Mutation onSuccess is registered before dismissSettings is defined; call
  // through a ref so Save can still leave the route after a successful update.
  const dismissSettingsRef = useRef<
    (options?: { ignoreBlocker?: boolean }) => void
  >(() => {})
  const [autoOpenAttempted, setAutoOpenAttempted] = useState(false)
  const config = useQuery(configQuery)
  const backendStatus = useQuery(agentBackendStatusQuery)
  const githubThrottle = useQuery(githubThrottleStatusQuery)
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
  const [previewProvider, setPreviewProvider] = useState<{
    id: string
    label: string
  } | null>(null)
  const [previewWarnings, setPreviewWarnings] = useState<readonly string[]>([])
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
  // Forward/explicit re-open resets this so abandoned drafts are not restored.
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
    setPreviewProvider(null)
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
      dismissSettingsRef.current({ ignoreBlocker: true })
    },
  })

  // Block Back (and other route leaves) while Save is in flight so navigation
  // cannot race an in-progress configuration update (issue #840).
  const updateConfigPendingRef = useRef(false)
  updateConfigPendingRef.current = updateConfig.isPending
  // Stable identity so useBlocker does not tear down/re-register every render.
  const shouldBlockSettingsLeave = useCallback(
    () => updateConfigPendingRef.current,
    [],
  )
  useBlocker({
    shouldBlockFn: shouldBlockSettingsLeave,
    enableBeforeUnload: updateConfig.isPending,
    disabled: !updateConfig.isPending,
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
        agentBackends: readonly AgentBackendListEntry[]
      }
      const current = queryClient.getQueryData<BackendStatusQueryData>(
        agentBackendStatusQuery.queryKey,
      )
      if (current == null) {
        // Never seed a partial cache without selectable-backend mode metadata —
        // an empty list would treat Claude as free-text and drop Bedrock Save
        // gates (#828). Refetch the combined status + backends query instead.
        void queryClient.invalidateQueries({
          queryKey: agentBackendStatusQuery.queryKey,
        })
      } else {
        queryClient.setQueryData<BackendStatusQueryData>(
          agentBackendStatusQuery.queryKey,
          {
            ...current,
            agentBackendStatuses: (() => {
              const priorStatuses = current.agentBackendStatuses ?? []
              return priorStatuses.some((row) => row.backend.id === backendId)
                ? priorStatuses.map((row) =>
                    row.backend.id === backendId ? rechecked : row,
                  )
                : [...priorStatuses, rechecked]
            })(),
            agentBackendStatus:
              backendId ===
              (config.data?.selectedAgentBackend ?? defaultBackendId)
                ? rechecked
                : (current.agentBackendStatus ?? rechecked),
            // Preserve agentBackends (configurationMode) from the prior fetch.
          },
        )
      }
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
      setPreviewProvider(null)
      setPreviewWarnings([])
      setPreviewError(null)
      setPreviewPending(false)
      return
    }

    setPreviewPending(true)
    setPreviewError(null)
    setPreviewProvider(null)
    setPreviewWarnings([])
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
            models: { id: true, thinkingLevels: true, name: true, kind: true },
            provider: { id: true, label: true },
            warnings: true,
          },
        }),
      ])
      // Ignore stale responses after a newer dropdown selection.
      if (generation !== previewGenerationRef.current) {
        return
      }
      applyModelPrefs(prefsResult.harnessModelPrefs)
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
  }

  /**
   * Reset form session state and refresh indefinitely-cached catalogs on open
   * (issue #838). Shared by explicit open, routed enter, and first-run.
   * Stored on a ref so the dialog-open effect can call the latest session
   * preparer without listing an unstable function in its dependency array.
   */
  const prepareSettingsSessionRef = useRef(() => {})
  prepareSettingsSessionRef.current = () => {
    // Allow one hydrate for this open (effect or inline below).
    formHydratedForOpenRef.current = false
    // Discard any in-flight preview from a previous dialog session.
    previewGenerationRef.current += 1
    // Refresh provider-mode and catalog metadata on every open. Both queries
    // are cached indefinitely so a long-open browser would otherwise keep a
    // catalog (and Claude configurationMode) from before a Harness restart and
    // offer models the running Harness no longer accepts (issue #838).
    void config.refetch()
    void models.refetch()
    void backendStatus.refetch()
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
    setPreviewProvider(null)
    setPreviewError(null)
    setPreviewPending(false)
    setRecheckAllFailures([])
    updateConfig.reset()
    recheckBackend.reset()
  }
  const prepareSettingsSession = () => {
    prepareSettingsSessionRef.current()
  }

  /**
   * Leave the `/settings` route: Back to the in-app origin when this SPA
   * session opened Settings explicitly, else replace with Pipeline so
   * Forward cannot reopen a direct-link or post-refresh entry.
   */
  const leaveSettingsRoute = (options?: { ignoreBlocker?: boolean }) => {
    const ignoreBlocker = options?.ignoreBlocker === true
    // Require both history marker and same-document session flag so a full
    // reload (which restores history state) still uses replace → `/`.
    const openedFromInApp =
      settingsOpenedFromInAppThisSessionRef.current &&
      settingsHistoryState?.kind === "in-app-origin"
    if (openedFromInApp && router.history.canGoBack()) {
      router.history.back({ ignoreBlocker })
      return
    }
    void navigate({
      to: "/",
      search: (prev) => prev,
      replace: true,
      ignoreBlocker,
    })
  }

  /**
   * Close Settings: local first-run only closes the native dialog; routed
   * opens also leave `/settings` (Save / Cancel / Escape share this path).
   */
  const dismissSettings = (options?: { ignoreBlocker?: boolean }) => {
    if (updateConfig.isPending && options?.ignoreBlocker !== true) {
      return
    }
    if (routedSettingsOpen) {
      dismissingRouteRef.current = true
      dialogRef.current?.close()
      setLocalSettingsOpen(false)
      leaveSettingsRoute(options)
      return
    }
    dialogRef.current?.close()
    setLocalSettingsOpen(false)
  }
  dismissSettingsRef.current = dismissSettings

  /** Explicit Settings openers (masthead, setup/backend guidance). */
  const openSettings = () => {
    prepareSettingsSession()
    if (routedSettingsOpen || settingsOpenNavigatePendingRef.current) {
      // Already on `/settings`, or a push is in flight: keep URL, refresh.
      if (dialogRef.current !== null && !dialogRef.current.open) {
        dialogRef.current.showModal()
      }
      return
    }
    settingsOpenedFromInAppThisSessionRef.current = true
    settingsOpenNavigatePendingRef.current = true
    // Open immediately so focus trap matches pre-route UX; the route effect
    // remains the source of truth for direct/forward entry and Back close.
    if (dialogRef.current !== null && !dialogRef.current.open) {
      dialogRef.current.showModal()
    }
    void navigate({
      to: "/settings",
      search: (prev) => prev,
      state: (prev) => {
        // HistoryState is an open bag; mark this entry as an explicit in-app open
        // so Cancel/Save/Escape can history.back() instead of replace-to-home.
        const next = { ...prev }
        Object.assign(next, {
          harnessSettings: { kind: "in-app-origin" as const },
        })
        return next
      },
    }).finally(() => {
      settingsOpenNavigatePendingRef.current = false
    })
  }

  // Sync native <dialog> with routed + local open flags.
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) {
      return
    }
    if (dialogOpen) {
      if (!dialog.open) {
        // Entering via route (direct, Forward, or explicit navigate) needs a
        // fresh session so abandoned drafts are not restored.
        prepareSettingsSessionRef.current()
        dialog.showModal()
      }
      return
    }
    if (dialog.open) {
      dismissingRouteRef.current = true
      dialog.close()
    }
  }, [dialogOpen])

  // Automatic first-run and Unavailable-backend recovery: local-only, no URL
  // change, and suppressed while another routed dialog is requested.
  useEffect(() => {
    const action = getHarnessSettingsAutoOpenAction({
      autoOpenAttempted,
      configLoaded: config.isSuccess,
      buildConfigured,
      backendStatusLoaded: backendStatus.isSuccess,
      defaultBackendUnavailable: backendKind === "UNAVAILABLE",
      otherRoutedDialogOpen: isOtherRoutedDialogPath(pathname),
      routedSettingsOpen,
    })
    if (action === "NONE") {
      return
    }
    setAutoOpenAttempted(true)
    if (action === "MARK_ATTEMPTED") {
      return
    }
    setLocalSettingsOpen(true)
    updateConfig.reset()
  }, [
    autoOpenAttempted,
    backendKind,
    backendStatus.isSuccess,
    buildConfigured,
    config.isSuccess,
    pathname,
    routedSettingsOpen,
    updateConfig.reset,
  ])

  const savedAgentBackend = config.data?.selectedAgentBackend ?? "opencode"
  const backendChanging = selectedAgentBackend !== savedAgentBackend

  const catalogModels: readonly AgentModelOption[] | undefined = backendChanging
    ? (previewModels ?? undefined)
    : models.data
  const catalogLoaded = catalogModels !== undefined
  const modelIds = (catalogModels ?? []).map((model) => model.id)
  // Draft backend while changing; otherwise the saved/selected harness default.
  const modelBackendId = selectedAgentBackend
  // configurationMode comes only from agentBackends on the status query. Until
  // that list successfully includes Claude, treat mode as unknown — fail closed
  // so a partial cache cannot present Bedrock as first-party (#828 review).
  // Model membership itself is catalog-only for every backend (#838); mode only
  // selects Bedrock-specific operator guidance wording.
  const agentBackendsList = backendStatus.data?.agentBackends
  const claudeBackendListEntry = agentBackendsList?.find(
    (backend) => backend.id === CLAUDE_AGENT_BACKEND_ID,
  )
  const claudeConfigurationModeUnresolved =
    modelBackendId === CLAUDE_AGENT_BACKEND_ID &&
    (backendStatus.isPending ||
      backendStatus.isError ||
      agentBackendsList === undefined ||
      claudeBackendListEntry === undefined)
  const modelConfigurationMode =
    (agentBackendsList ?? []).find((backend) => backend.id === modelBackendId)
      ?.configurationMode ?? null
  const claudeBedrockStrict =
    !claudeConfigurationModeUnresolved &&
    isClaudeBedrockConfigurationMode(modelBackendId, modelConfigurationMode)
  const buildVariants = thinkingLevelsForModel(catalogModels, defaultModel)
  const reviewThinkingLevelSourceModel =
    reviewModel.length > 0 ? reviewModel : defaultModel
  const reviewThinkingLevels = thinkingLevelsForModel(
    catalogModels,
    reviewThinkingLevelSourceModel,
  )
  // Catalog membership is required for every Agent Backend (#838). Only claim
  // "unavailable" once a catalog loaded so a pending fetch cannot flash an
  // alarm for a value that may yet match.
  const buildEffortSourceUnavailable =
    catalogLoaded &&
    isUnavailableCatalogModel({
      modelId: defaultModel,
      catalogModelIds: modelIds,
    })
  const reviewEffortSourceUnavailable =
    catalogLoaded &&
    isUnavailableCatalogModel({
      modelId: reviewThinkingLevelSourceModel,
      catalogModelIds: modelIds,
    })
  const hasCustomBuildVariant =
    defaultThinkingLevel.length > 0 &&
    (buildEffortSourceUnavailable ||
      !buildVariants.includes(defaultThinkingLevel))
  const hasCustomReviewVariant =
    reviewThinkingLevel.length > 0 &&
    (reviewEffortSourceUnavailable ||
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
  // isFetching, not isPending: opening Settings refetches, and React Query
  // would otherwise keep serving the previous catalog while that request is in
  // flight — exactly the indefinitely-cached catalog a Harness restart must
  // invalidate (issue #838). Treat a refresh as "no catalog yet" so no stale
  // model is offered and Save stays blocked until the current one arrives.
  const modelsLoading =
    dialogOpen &&
    (backendChanging
      ? previewPending
      : models.isFetching || backendStatus.isFetching)
  const discoveryWarningsForModels = backendChanging
    ? previewWarnings
    : (defaultStatus?.warnings ??
      statuses.find((row) => row.backend.id === modelBackendId)?.warnings ??
      [])
  const catalogFailed =
    !backendChanging &&
    !modelsLoading &&
    (models.isError || backendStatus.isError)
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
  // Harness Config always requires a build model; the review model is optional
  // and falls back to the build model. Both are catalog-only for every Agent
  // Backend (issue #838).
  const blockSaveForBuildModel = blocksAgentModelSave({
    ...catalogState,
    modelId: defaultModel,
    requireSelection: true,
  })
  const blockSaveForReviewModel = blocksAgentModelSave({
    ...catalogState,
    modelId: reviewModel,
    requireSelection: false,
  })
  const buildModelBlockReason = agentModelSaveBlockReason({
    ...catalogState,
    modelId: defaultModel,
    requireSelection: true,
  })
  const reviewModelBlockReason = agentModelSaveBlockReason({
    ...catalogState,
    modelId: reviewModel,
    requireSelection: false,
  })
  const modelSelectDisabled =
    modelsDisabled ||
    catalogLoading ||
    catalogFailed ||
    catalogModels === undefined ||
    catalogModels.length === 0
  // Single Save gate used by both the submit button and form onSubmit so Enter
  // cannot bypass a disabled Save control (issue #828 review).
  const harnessSettingsSaveBlocked =
    config.isPending ||
    config.isError ||
    modelsLoading ||
    updateConfig.isPending ||
    // Claude mode unknown (pending/error/missing agentBackends entry) — fail closed.
    claudeConfigurationModeUnresolved ||
    (backendChangeBlocked && backendChanging) ||
    (backendChanging && previewError !== null) ||
    blockSaveForBuildModel ||
    blockSaveForReviewModel

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Live gates can flip while a draft is staged; disabled controls do not
    // stop implicit form submit (Enter) — re-check every Save gate here.
    if (harnessSettingsSaveBlocked) {
      return
    }
    const parsedMaxSessions = Number(maxConcurrentAgentTurns)
    const parsedMaxWorkItems = Number(maxConcurrentWorkItems)
    updateConfig.mutate({
      selectedAgentBackend,
      defaultModel: defaultModel.trim() === "" ? null : defaultModel.trim(),
      defaultThinkingLevel:
        defaultThinkingLevel.trim() === "" ? null : defaultThinkingLevel.trim(),
      reviewModel: reviewModel.trim() === "" ? null : reviewModel.trim(),
      reviewThinkingLevel:
        reviewThinkingLevel.trim() === "" ? null : reviewThinkingLevel.trim(),
      maxConcurrentAgentTurns: parsedMaxSessions,
      maxConcurrentWorkItems: parsedMaxWorkItems,
    })
  }

  const recheckBusy =
    recheckBackend.isPending ||
    recheckAllPending ||
    recheckingBackendId !== null

  return (
    <JobsRepositoryFilterProvider>
      <div className={ui.appChrome}>
        <header className={ui.mast}>
          <MastheadScrollwork />
          <div className={ui.mastContent}>
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
            {/* Settings cog — prototype B gear (SVG teeth + iron core). */}
            <button
              type="button"
              className={ui.mastSettingsCog}
              onClick={openSettings}
              aria-haspopup="dialog"
              aria-label="Settings"
            >
              <span className="cog-body" aria-hidden="true">
                <SettingsCogTeeth />
                <span className="core">
                  <SettingsNavIcon />
                </span>
              </span>
              <span className="label-ring">Settings</span>
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
        <GitHubThrottleBanner retryAt={githubThrottle.data?.retryAt} />
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
          if (updateConfig.isPending) {
            event.preventDefault()
          }
        }}
        onClose={() => {
          // Escape (or other user dismiss) closes the native dialog first; if
          // we are still on `/settings`, leave the route so URL and UI match.
          if (dismissingRouteRef.current) {
            dismissingRouteRef.current = false
            setLocalSettingsOpen(false)
            return
          }
          setLocalSettingsOpen(false)
          if (isHarnessSettingsPath(pathname)) {
            leaveSettingsRoute()
          }
        }}
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

          <div className={ui.dialogBodySectioned}>
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
                <section
                  className={ui.dialogSection}
                  aria-labelledby="settings-sec-agent"
                >
                  <div className={ui.dialogSectionHead}>
                    <h3
                      id="settings-sec-agent"
                      className={ui.dialogSectionTitle}
                    >
                      Agent backend
                    </h3>
                    <span className={ui.dialogSectionMeta}>
                      Session default
                    </span>
                  </div>
                  <label className={ui.dialogField}>
                    Default Agent Backend
                    <select
                      className={ui.dialogInput}
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
                      const rowRechecking =
                        recheckingBackendId === row.backend.id
                      const previewingThisRow =
                        backendChanging &&
                        row.backend.id === selectedAgentBackend
                      // When previewing a not-yet-saved selection, prefer the
                      // previewed provider so Bedrock identity shows before Save.
                      const providerForRow =
                        previewingThisRow && previewProvider !== null
                          ? previewProvider
                          : row.provider
                      // Derive readiness from the live preview once it finishes so
                      // we never mix a fresh Bedrock identity with stale Active
                      // Unavailable reason (issue #819 review).
                      let kindForRow = row.kind
                      let reasonForRow =
                        row.kind === "UNAVAILABLE" ? row.reason : null
                      let warningsForRow =
                        previewingThisRow && !previewPending
                          ? previewWarnings
                          : (row.warnings ?? [])
                      if (previewingThisRow && !previewPending) {
                        if (previewError !== null) {
                          kindForRow = "UNAVAILABLE"
                          reasonForRow = previewError
                          warningsForRow = []
                        } else {
                          kindForRow = "READY"
                          reasonForRow = null
                        }
                      }
                      return (
                        <div
                          key={row.backend.id}
                          className={ui.dialogStatusRow}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="m-0">
                              <strong>{row.backend.label}</strong>
                              {formatAgentBackendStatusTrail({
                                kind: kindForRow,
                                provider: providerForRow,
                                isDefault,
                                previewing: previewingThisRow,
                                reason: reasonForRow,
                              })}
                            </p>
                            {kindForRow === "READY" && (
                              <AgentBackendWarnings warnings={warningsForRow} />
                            )}
                          </div>
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
                    {backendChanging &&
                      !statuses.some(
                        (row) => row.backend.id === selectedAgentBackend,
                      ) &&
                      selectedAgentBackend !==
                        (defaultStatus?.backend.id ?? "") && (
                        <div className={ui.dialogStatusRow}>
                          <div className="min-w-0 flex-1">
                            <p className="m-0">
                              <strong>
                                {(backendStatus.data?.agentBackends ?? []).find(
                                  (backend) =>
                                    backend.id === selectedAgentBackend,
                                )?.label ?? selectedAgentBackend}
                              </strong>
                              {previewPending
                                ? " · Previewing selection…"
                                : formatAgentBackendStatusTrail({
                                    kind:
                                      previewError !== null
                                        ? "UNAVAILABLE"
                                        : "READY",
                                    provider: previewProvider,
                                    previewing: true,
                                    reason: previewError,
                                  })}
                            </p>
                            {!previewPending && previewError === null && (
                              <AgentBackendWarnings
                                warnings={previewWarnings}
                              />
                            )}
                          </div>
                        </div>
                      )}
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
                </section>

                <section
                  className={ui.dialogSection}
                  aria-labelledby="settings-sec-models"
                >
                  <div className={ui.dialogSectionHead}>
                    <h3
                      id="settings-sec-models"
                      className={ui.dialogSectionTitle}
                    >
                      Models
                    </h3>
                    <span className={ui.dialogSectionMeta}>Build · Review</span>
                  </div>

                  <AgentModelSelect
                    className={cx(ui.dialogField, ui.dialogFieldMono)}
                    label="Build model"
                    name="defaultModel"
                    value={defaultModel}
                    models={catalogModels}
                    catalogLoading={catalogLoading}
                    allowClear={false}
                    required
                    disabled={modelSelectDisabled}
                    placeholder={
                      claudeBedrockStrict
                        ? "Select a Bedrock inference profile"
                        : "Select a build model"
                    }
                    emptyCatalogLabel={
                      claudeBedrockStrict
                        ? "No Bedrock profiles available"
                        : "No Agent Models available"
                    }
                    blockReason={buildModelBlockReason}
                    hint={
                      claudeBedrockStrict
                        ? "Choose an active Anthropic-backed Bedrock inference profile for the resolved AWS region. Used for implement and other build steps."
                        : "Used for implement and other build steps."
                    }
                    onChange={(nextModel) => {
                      setDefaultModel(nextModel)
                      const nextVariants = thinkingLevelsForModel(
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
                  />

                  {defaultModel.length > 0 && buildEffortSourceUnavailable ? (
                    <Banner
                      className={ui.bannerCompact}
                      tone="alarm"
                      tag="Model"
                      role="alert"
                    >
                      Build effort (thinking) is unavailable — the selected
                      model is not in the Agent Model catalog. Choose another
                      build model.
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
                        className={ui.dialogInput}
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
                      <span className={ui.dialogFieldHint}>
                        Optional effort (thinking) for this model. Options come
                        from the selected model.
                      </span>
                    </label>
                  )}

                  <AgentModelSelect
                    className={cx(ui.dialogField, ui.dialogFieldMono)}
                    label="Review model"
                    name="reviewModel"
                    value={reviewModel}
                    models={catalogModels}
                    catalogLoading={catalogLoading}
                    allowClear
                    required={false}
                    disabled={modelSelectDisabled}
                    placeholder="Same as build model"
                    emptyCatalogLabel="Same as build model"
                    blockReason={reviewModelBlockReason}
                    hint={
                      claudeBedrockStrict
                        ? "Optional review profile from the same Bedrock catalog. Empty uses the build model."
                        : "Used only for the review step. Empty uses the build model."
                    }
                    onChange={(nextModel) => {
                      setReviewModel(nextModel)
                      const nextVariants = thinkingLevelsForModel(
                        catalogModels,
                        nextModel.length > 0 ? nextModel : defaultModel,
                      )
                      setReviewVariant((current) =>
                        reconcileVariantForModel(current, nextVariants),
                      )
                    }}
                  />

                  {reviewThinkingLevelSourceModel.length > 0 &&
                  reviewEffortSourceUnavailable ? (
                    <Banner
                      className={ui.bannerCompact}
                      tone="alarm"
                      tag="Model"
                      role="alert"
                    >
                      Review effort (thinking) is unavailable — the selected
                      model is not in the Agent Model catalog. Choose another
                      model or use the build model.
                    </Banner>
                  ) : reviewThinkingLevelSourceModel.length > 0 &&
                    reviewThinkingLevels.length === 0 ? (
                    <p className={ui.dialogNote}>
                      Review effort (thinking) is unavailable — this model has
                      no effort (thinking) options.
                    </p>
                  ) : (
                    <label className={ui.dialogField}>
                      Review effort (thinking)
                      <select
                        className={ui.dialogInput}
                        name="reviewThinkingLevel"
                        value={reviewThinkingLevel}
                        onChange={(event) =>
                          setReviewVariant(event.target.value)
                        }
                        disabled={
                          modelsDisabled ||
                          reviewThinkingLevelSourceModel.length === 0 ||
                          reviewThinkingLevels.length === 0
                        }
                      >
                        <option value="">
                          Same as build effort (thinking)
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
                </section>

                <section
                  className={ui.dialogSection}
                  aria-labelledby="settings-sec-concurrency"
                >
                  <div className={ui.dialogSectionHead}>
                    <h3
                      id="settings-sec-concurrency"
                      className={ui.dialogSectionTitle}
                    >
                      Concurrency
                    </h3>
                    <span className={ui.dialogSectionMeta}>Fleet caps</span>
                  </div>

                  <label className={ui.dialogField}>
                    Max concurrent Agent Turns
                    <input
                      className={ui.dialogInput}
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
                      Caps how many Agent Turn CLI processes run at once
                      (default 2). Agent-free steps and model listing are not
                      counted.
                    </span>
                  </label>

                  <label className={ui.dialogField}>
                    Max concurrent Work Items
                    <input
                      className={ui.dialogInput}
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
                      Slots, default 5). Extra Implement requests wait for a
                      free slot.
                    </span>
                  </label>
                </section>
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
                dismissSettings()
              }}
              disabled={updateConfig.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={ui.platePrimary}
              aria-busy={updateConfig.isPending || undefined}
              disabled={harnessSettingsSaveBlocked}
            >
              {updateConfig.isPending ? "Saving…" : "Save settings"}
            </button>
          </div>
        </form>
      </dialog>
    </JobsRepositoryFilterProvider>
  )
}
