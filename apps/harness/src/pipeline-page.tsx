import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { type FormEvent, Suspense, useEffect, useState } from "react"
import { Banner, BannerActionButton } from "./banner.js"
import { createHarnessGraphqlClient } from "./harness-graphql.js"
import { KanbanBoard } from "./kanban-board.js"
import { openPullRequestCountsQueryKey } from "./refresh-open-pull-request-count-live.js"
import {
  followRepositoryMembershipLive,
  liveUpdatesWarningPresentation,
} from "./refresh-repositories-live.js"
import {
  type Forge,
  decodeForge,
  repositoriesQuery,
} from "./repositories-query.js"
import { cx, ui } from "./ui.js"

const graphql = createHarnessGraphqlClient({ batch: true })
// Long-lived host folder dialog must not pin co-batched GraphQL operations.
const graphqlUnbatched = createHarnessGraphqlClient({ batch: false })

export const addRepositoryCommandQuery = {
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

/**
 * Pipeline page body (home board or empty blank slate). This non-route module
 * is the canonical background for the home, Settings, and Session Telemetry
 * routes, so their route modules can code-split independently.
 *
 * Membership SSE stays mounted on all three paths so CLI add/remove refreshes
 * the blank-slate ↔ board gate without navigating away (issue #684 review).
 */
export function PipelinePage() {
  return (
    <>
      <HomeRepositoryMembershipLive />
      <HomeContent />
    </>
  )
}

/**
 * Transport-health membership subscription for Pipeline backgrounds. Board
 * issues/work-items live updates stay on `KanbanLiveUpdates`; `/repos` owns
 * its own copy via `RepositoryCards`.
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
  // Soft-fail repositories so a load error cannot unmount Pipeline chrome
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

/** Shared zero-repo blank slate used by Pipeline backgrounds and `/repos`. */
export function EmptyRepositoriesBlankSlate() {
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

export function AddRepositoryGuidance({
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
    forge: Forge
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
          mergePolicy: true,
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
        queryKey: openPullRequestCountsQueryKey,
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
        forge: decodeForge(result.forge),
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
              className={
                inspection !== null || addLocalRepository.isPending
                  ? ui.plateReady
                  : ui.platePrimary
              }
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
                className={ui.blankSlateFieldControl}
                value={inspection.forge}
                onChange={(event) =>
                  setInspection({
                    ...inspection,
                    forge: decodeForge(event.target.value),
                  })
                }
              >
                <option value="github">GitHub</option>
                <option value="gitlab">GitLab</option>
                <option value="azure-devops">Azure DevOps</option>
              </select>
            </label>
            <label className={ui.blankSlateField}>
              Forge host:
              <input
                className={ui.blankSlateFieldControl}
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
                className={ui.blankSlateFieldControl}
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
