import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Suspense, useEffect, useState } from "react"
import { createClient } from "@ready-for-agent/graphql-client"
import { followRepositoryIssuesLive } from "../refresh-issues-live.js"
import { streamRepositoryChanges } from "../repository-live.js"

const graphql = createClient({ url: "/graphql", batch: true })

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
    </main>
  )
}

function RepositoryCards() {
  const queryClient = useQueryClient()
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)
  const [liveUpdatesUnavailable, setLiveUpdatesUnavailable] = useState(false)
  const repositoryIdsKey = repositories.map(({ id }) => id).join("\0")

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
    const repositoryIds =
      repositoryIdsKey === "" ? [] : repositoryIdsKey.split("\0")
    void followRepositoryIssuesLive({
      repositoryIds,
      queryClient,
      queries: {
        repositories: repositoriesQuery,
        issues: issuesQuery,
      },
      signal: controller.signal,
    })
    return () => controller.abort()
  }, [queryClient, repositoryIdsKey])

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
        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))] gap-4"
        aria-label="Configured repositories"
      >
        {repositories.map((repository) => (
          <RepositoryCard key={repository.id} repository={repository} />
        ))}
      </section>
    </>
  )
}

function RepositoryCard({ repository }: { repository: Repository }) {
  const queryClient = useQueryClient()
  const [githubTokenCreated, setGithubTokenCreated] = useState(false)

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
  })

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
      <button
        type="button"
        className="absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-wait disabled:opacity-50"
        onClick={confirmRemoval}
        disabled={removeRepository.isPending}
        aria-label={`Remove ${repository.githubOwner}/${repository.githubRepo}`}
        title={`Remove ${repository.githubOwner}/${repository.githubRepo}`}
      >
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
      </button>
      <div className="mb-[1.4rem] flex items-center justify-between gap-4 pr-10">
        <h2 className="m-0 min-w-0 truncate text-2xl tracking-[-0.025em]">
          <a
            className="text-slate-900 hover:underline"
            href={`https://github.com/${repository.githubOwner}/${repository.githubRepo}`}
          >
            {repository.githubOwner}/{repository.githubRepo}
          </a>
        </h2>
        <span
          className={`shrink-0 rounded-full px-[0.55rem] py-[0.2rem] text-[0.7rem] font-[750] tracking-[0.04em] uppercase ${repository.paused ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}
        >
          {repository.paused ? "Paused" : "Active"}
        </span>
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
            disabled={
              refreshIssues.isPending || !repository.credential.configured
            }
            onClick={() => refreshIssues.mutate()}
            aria-label={
              refreshIssues.isPending ? "Refreshing issues" : "Refresh issues"
            }
            title={
              repository.credential.configured
                ? "Refresh issues"
                : "Add a GitHub token before refreshing issues"
            }
          >
            <svg
              aria-hidden="true"
              className={`size-4 ${refreshIssues.isPending ? "animate-spin motion-reduce:animate-none" : ""}`}
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
            <RepositoryIssues repositoryId={repository.id} />
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

function RepositoryIssues({ repositoryId }: { repositoryId: string }) {
  const { data: issues } = useSuspenseQuery(issuesQuery(repositoryId))

  if (issues.length === 0) {
    return <p className="m-0 text-sm text-slate-500">No relevant issues.</p>
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
          return <RepositoryIssueRow issue={issue} key={issue.id} />
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
                  <RepositoryIssueRow issue={child} key={child.id} />
                ))}
              </ul>
            </details>
          </li>
        )
      })}
    </ul>
  )
}

function RepositoryIssueRow({ issue }: { issue: RepositoryIssue }) {
  const isActionable = issue.state === "OPEN" && issue.blockedBy.length === 0
  const [menuOpen, setMenuOpen] = useState(false)

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
          {isActionable && (
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
                  className="absolute top-full right-0 z-10 mt-1 min-w-40 rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
                    onClick={() => setMenuOpen(false)}
                  >
                    Implement now
                  </button>
                </div>
              )}
            </span>
          )}
        </span>
      </div>
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
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))] gap-4"
      aria-label="Loading repositories"
      aria-busy="true"
    >
      {[0, 1, 2].map((item) => (
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
