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
        defaultModel: true,
        defaultThinkingLevel: true,
        reviewModel: true,
        reviewThinkingLevel: true,
        maxConcurrentAgentTurns: true,
        maxConcurrentWorkItems: true,
      },
    })
    return result.config
  },
}

type AgentModelOption = {
  id: string
  thinkingLevels: readonly string[]
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
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p>Page not found.</p>
      <Link to="/">Back home</Link>
    </div>
  ),
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen min-w-80 bg-slate-50 font-sans text-slate-900 antialiased [font-synthesis:none] [text-rendering:optimizeLegibility]">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function RootComponent() {
  return (
    <div className="mx-auto min-h-screen max-w-7xl p-4 sm:p-6">
      <nav className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 pb-4">
        <Link
          to="/"
          className="font-medium text-slate-700 hover:underline"
          activeProps={{ className: "font-bold text-slate-900" }}
          activeOptions={{ exact: true }}
        >
          Home
        </Link>
        <span
          className="text-sm tabular-nums text-slate-500"
          title={`Ready for Agent ${READY_FOR_AGENT_VERSION_LABEL}`}
        >
          {READY_FOR_AGENT_VERSION_LABEL}
        </span>
        <SettingsButton />
      </nav>
      <Outlet />
      <ReactQueryDevtools buttonPosition="bottom-left" />
      <TanStackRouterDevtools position="bottom-right" />
    </div>
  )
}

function SettingsButton() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [autoOpenAttempted, setAutoOpenAttempted] = useState(false)
  const config = useQuery(configQuery)
  const models = useQuery({ ...modelsQuery, enabled: dialogOpen })
  const [defaultModel, setDefaultModel] = useState("")
  const [defaultThinkingLevel, setDefaultVariant] = useState("")
  const [reviewModel, setReviewModel] = useState("")
  const [reviewThinkingLevel, setReviewVariant] = useState("")
  const [maxConcurrentAgentTurns, setMaxConcurrentOpencodeSessions] =
    useState("2")
  const [maxConcurrentWorkItems, setMaxConcurrentWorkItems] = useState("5")
  const buildConfigured = isBuildModelConfigured(config.data)

  useEffect(() => {
    if (!dialogOpen || !config.data) {
      return
    }
    setDefaultModel(config.data.defaultModel ?? "")
    setDefaultVariant(config.data.defaultThinkingLevel ?? "")
    setReviewModel(config.data.reviewModel ?? "")
    setReviewVariant(config.data.reviewThinkingLevel ?? "")
    setMaxConcurrentOpencodeSessions(
      String(config.data.maxConcurrentAgentTurns),
    )
    setMaxConcurrentWorkItems(String(config.data.maxConcurrentWorkItems))
  }, [config.data, dialogOpen])

  const updateConfig = useMutation({
    mutationFn: (input: {
      defaultModel: string
      defaultThinkingLevel: string | null
      reviewModel: string | null
      reviewThinkingLevel: string | null
      maxConcurrentAgentTurns: number
      maxConcurrentWorkItems: number
    }) =>
      graphql.mutation({
        updateConfig: {
          __args: { input },
          defaultModel: true,
          defaultThinkingLevel: true,
          reviewModel: true,
          reviewThinkingLevel: true,
          maxConcurrentAgentTurns: true,
          maxConcurrentWorkItems: true,
        },
      }),
    onSuccess: ({ updateConfig: updatedConfig }) => {
      queryClient.setQueryData(configQuery.queryKey, updatedConfig)
      dialogRef.current?.close()
      setDialogOpen(false)
    },
  })

  const openSettings = () => {
    setDialogOpen(true)
    if (config.isError) {
      void config.refetch()
    }
    if (models.isError) {
      void models.refetch()
    }
    if (config.data) {
      setDefaultModel(config.data.defaultModel ?? "")
      setDefaultVariant(config.data.defaultThinkingLevel ?? "")
      setReviewModel(config.data.reviewModel ?? "")
      setReviewVariant(config.data.reviewThinkingLevel ?? "")
      setMaxConcurrentOpencodeSessions(
        String(config.data.maxConcurrentAgentTurns),
      )
      setMaxConcurrentWorkItems(String(config.data.maxConcurrentWorkItems))
    }
    updateConfig.reset()
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

  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsedMaxSessions = Number(maxConcurrentAgentTurns)
    const parsedMaxWorkItems = Number(maxConcurrentWorkItems)
    updateConfig.mutate({
      defaultModel,
      defaultThinkingLevel:
        defaultThinkingLevel.trim() === "" ? null : defaultThinkingLevel,
      reviewModel: reviewModel.trim() === "" ? null : reviewModel,
      reviewThinkingLevel:
        reviewThinkingLevel.trim() === "" ? null : reviewThinkingLevel,
      maxConcurrentAgentTurns: parsedMaxSessions,
      maxConcurrentWorkItems: parsedMaxWorkItems,
    })
  }

  const modelIds = (models.data ?? []).map((model) => model.id)
  const buildVariants = variantsForModel(models.data, defaultModel)
  const reviewThinkingLevelSourceModel =
    reviewModel.length > 0 ? reviewModel : defaultModel
  const reviewThinkingLevels = variantsForModel(
    models.data,
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
  const showUnconfiguredGuidance = config.isSuccess && !buildConfigured

  return (
    <>
      {showUnconfiguredGuidance && !dialogOpen && (
        <div
          className="mr-auto flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-950"
          role="status"
        >
          <span>Select a default build model first</span>
          <button
            type="button"
            className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-950 underline-offset-2 hover:bg-amber-200 hover:underline"
            onClick={openSettings}
          >
            Open Settings
          </button>
        </div>
      )}
      <button
        type="button"
        className="ml-auto inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        onClick={openSettings}
        aria-haspopup="dialog"
      >
        <svg
          aria-hidden="true"
          className="size-4"
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

      <dialog
        ref={dialogRef}
        className="m-auto w-[min(92vw,31rem)] rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/45"
        aria-labelledby="settings-title"
        onCancel={(event) => {
          if (updateConfig.isPending) event.preventDefault()
        }}
        onClose={() => setDialogOpen(false)}
      >
        <form onSubmit={saveSettings}>
          <div className="border-b border-slate-200 px-6 py-5">
            <p className="text-xs font-extrabold tracking-[0.12em] text-blue-600 uppercase">
              Harness defaults
            </p>
            <h2 id="settings-title" className="mt-1 text-2xl font-bold">
              Harness settings
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Defaults for agent sessions and Agent Turn concurrency.
            </p>
            {showUnconfiguredGuidance && (
              <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
                Select a default build model before the harness can create work.
              </p>
            )}
          </div>

          <div className="grid gap-5 px-6 py-5">
            {config.isPending || (dialogOpen && models.isPending) ? (
              <p className="text-sm text-slate-500">Loading settings...</p>
            ) : config.isError || models.isError ? (
              <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                Settings could not be loaded. Close this dialog and try again.
              </p>
            ) : (
              <>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Build model
                  <select
                    className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    name="defaultModel"
                    value={defaultModel}
                    onChange={(event) => {
                      const nextModel = event.target.value
                      setDefaultModel(nextModel)
                      const nextVariants = variantsForModel(
                        models.data,
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
                    required
                  >
                    {!buildConfigured && defaultModel.length === 0 && (
                      <option value="" disabled>
                        Select a build model
                      </option>
                    )}
                    {hasUnavailableBuildModel && (
                      <option value={defaultModel}>
                        {defaultModel} (not in Agent Model catalog)
                      </option>
                    )}
                    {(models.data ?? []).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs font-normal text-slate-500">
                    Used for implement and other build steps.
                  </span>
                </label>

                {defaultModel.length > 0 && hasUnavailableBuildModel ? (
                  <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
                    Build thinking level is unavailable — the selected model is
                    not in the Agent Model catalog. Choose another build model.
                  </p>
                ) : defaultModel.length > 0 && buildVariants.length === 0 ? (
                  <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                    Build thinking level is unavailable — this model has no
                    Thinking Levels.
                  </p>
                ) : (
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                    Build thinking level
                    <select
                      className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      name="defaultThinkingLevel"
                      value={defaultThinkingLevel}
                      onChange={(event) =>
                        setDefaultVariant(event.target.value)
                      }
                      disabled={defaultModel.length === 0}
                    >
                      <option value="">
                        {buildVariants.length === 0
                          ? "Model default (no Thinking Levels)"
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
                    <span className="text-xs font-normal text-slate-500">
                      Optional Thinking Level for this model. Options come from
                      the selected model.
                    </span>
                  </label>
                )}

                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Review model
                  <select
                    className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    name="reviewModel"
                    value={reviewModel}
                    onChange={(event) => {
                      const nextModel = event.target.value
                      setReviewModel(nextModel)
                      const nextVariants = variantsForModel(
                        models.data,
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
                    {(models.data ?? []).map((model) => (
                      <option key={`review-${model.id}`} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs font-normal text-slate-500">
                    Used only for the review step. Empty uses the build model.
                  </span>
                </label>

                {reviewThinkingLevelSourceModel.length > 0 &&
                ((reviewModel.length > 0 && hasUnavailableReviewModel) ||
                  (reviewModel.length === 0 && hasUnavailableBuildModel)) ? (
                  <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950">
                    Review thinking level is unavailable — the selected model is
                    not in the Agent Model catalog. Choose another model or use
                    the build model.
                  </p>
                ) : reviewThinkingLevelSourceModel.length > 0 &&
                  reviewThinkingLevels.length === 0 ? (
                  <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                    Review thinking level is unavailable — this model has no
                    Thinking Levels.
                  </p>
                ) : (
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                    Review thinking level
                    <select
                      className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      name="reviewThinkingLevel"
                      value={reviewThinkingLevel}
                      onChange={(event) => setReviewVariant(event.target.value)}
                      disabled={
                        reviewThinkingLevelSourceModel.length === 0 ||
                        reviewThinkingLevels.length === 0
                      }
                    >
                      <option value="">Same as build thinking level</option>
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
                    className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
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
                  <span className="text-xs font-normal text-slate-500">
                    Caps how many OpenCode lifecycle processes run at once
                    (default 2). Non-OpenCode steps and model listing are not
                    counted.
                  </span>
                </label>

                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Max concurrent Work Items
                  <input
                    className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
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
                  <span className="text-xs font-normal text-slate-500">
                    Caps how many Work Items may be Admitted at once (Worker
                    Slots, default 5). Extra Implement requests wait for a free
                    slot.
                  </span>
                </label>
              </>
            )}

            {updateConfig.isError && (
              <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
                Settings could not be saved. Check the values and try again.
              </p>
            )}
          </div>

          <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-6 py-4">
            <button
              type="button"
              className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-200"
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
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={
                config.isPending ||
                config.isError ||
                models.isPending ||
                models.isError ||
                updateConfig.isPending ||
                defaultModel.length === 0 ||
                hasUnavailableBuildModel
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
