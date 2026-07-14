import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Suspense, useState } from "react"
import { createClient } from "@ready-for-agent/graphql-client"

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
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)

  if (repositories.length === 0) {
    return (
      <div className="rounded-[0.9rem] border border-dashed border-slate-300 px-6 py-12 text-center">
        <h2 className="m-0">No repositories configured</h2>
        <p className="mt-1.5 text-slate-500">
          Add a local Git repository with the CLI:
        </p>
        <code className="mt-3 inline-block rounded-md bg-slate-100 px-3 py-2 font-mono text-sm text-slate-800">
          bun run harness-cli add /path/to/local/repo
        </code>
      </div>
    )
  }

  return (
    <section
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,19rem),1fr))] gap-4"
      aria-label="Configured repositories"
    >
      {repositories.map((repository) => (
        <RepositoryCard key={repository.id} repository={repository} />
      ))}
    </section>
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
    mutationFn: () =>
      graphql.mutation({
        refreshRepository: {
          __args: { repositoryId: repository.id },
          fetched: true,
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: repositoriesQuery.queryKey }),
        queryClient.invalidateQueries({
          queryKey: issuesQuery(repository.id).queryKey,
        }),
      ])
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
            Issues
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
    return (
      <p className="m-0 text-sm text-slate-500">No Ready-labeled issues.</p>
    )
  }

  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {issues.map((issue) => (
        <li className="flex min-w-0 items-start gap-2 text-sm" key={issue.id}>
          <span className="shrink-0 font-mono text-xs leading-5 text-slate-400">
            #{issue.githubIssueNumber}
          </span>
          <a
            className="min-w-0 flex-1 text-slate-700 hover:text-blue-700 hover:underline"
            href={issue.url}
          >
            {issue.title}
          </a>
          {issue.state === "CLOSED" && (
            <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[0.6rem] font-bold tracking-wide text-slate-500 uppercase">
              Closed
            </span>
          )}
        </li>
      ))}
    </ul>
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
