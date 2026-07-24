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

function RootComponent() {
  return (
    <div className="mx-auto min-h-screen w-full max-w-[88rem] px-5 py-6 sm:px-8 lg:px-12">
      <nav className="mb-2 flex flex-wrap items-start gap-x-5 gap-y-3 border-b-2 border-ink pb-3">
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
      <button
        type="button"
        className="ml-auto inline-flex items-center gap-2 border border-rule-2 bg-panel px-3 py-1.5 text-xs font-semibold tracking-[0.14em] text-ink-2 uppercase transition hover:border-ink-soft hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood"
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
                Select a default build model before the harness can create work.
              </p>
            )}
          </div>

          <div className="grid gap-5 px-6 py-5">
            {config.isPending || (dialogOpen && models.isPending) ? (
              <p className="text-sm text-ink-soft">Loading settings...</p>
            ) : config.isError || models.isError ? (
              <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                Settings could not be loaded. Close this dialog and try again.
              </p>
            ) : (
              <>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Build model
                  <select
                    className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 font-mono text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15"
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
                  <span className="text-xs font-normal text-ink-faint">
                    Used for implement and other build steps.
                  </span>
                </label>

                {defaultModel.length > 0 && hasUnavailableBuildModel ? (
                  <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                    Build thinking level is unavailable — the selected model is
                    not in the Agent Model catalog. Choose another build model.
                  </p>
                ) : defaultModel.length > 0 && buildVariants.length === 0 ? (
                  <p className="bg-paper-2 p-3 text-sm text-ink-soft">
                    Build thinking level is unavailable — this model has no
                    Thinking Levels.
                  </p>
                ) : (
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                    Build thinking level
                    <select
                      className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15"
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
                    <span className="text-xs font-normal text-ink-faint">
                      Optional Thinking Level for this model. Options come from
                      the selected model.
                    </span>
                  </label>
                )}

                <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                  Review model
                  <select
                    className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 font-mono text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15"
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
                  <span className="text-xs font-normal text-ink-faint">
                    Used only for the review step. Empty uses the build model.
                  </span>
                </label>

                {reviewThinkingLevelSourceModel.length > 0 &&
                ((reviewModel.length > 0 && hasUnavailableReviewModel) ||
                  (reviewModel.length === 0 && hasUnavailableBuildModel)) ? (
                  <p className="border border-oxblood/40 bg-oxblood-wash p-3 text-sm text-oxblood-deep">
                    Review thinking level is unavailable — the selected model is
                    not in the Agent Model catalog. Choose another model or use
                    the build model.
                  </p>
                ) : reviewThinkingLevelSourceModel.length > 0 &&
                  reviewThinkingLevels.length === 0 ? (
                  <p className="bg-paper-2 p-3 text-sm text-ink-soft">
                    Review thinking level is unavailable — this model has no
                    Thinking Levels.
                  </p>
                ) : (
                  <label className="grid min-w-0 gap-1.5 text-sm font-semibold">
                    Review thinking level
                    <select
                      className="w-full min-w-0 border border-rule-2 bg-paper px-3 py-2 text-sm font-normal outline-none focus:border-oxblood focus:ring-2 focus:ring-oxblood/15"
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
                    Caps how many OpenCode lifecycle processes run at once
                    (default 2). Non-OpenCode steps and model listing are not
                    counted.
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
                Settings could not be saved. Check the values and try again.
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
