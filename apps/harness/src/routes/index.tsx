import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Suspense } from "react"
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
    })
    return result.repositories
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
          Add a repository with the CLI to see it here.
        </p>
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

function RepositoryCard({
  repository,
}: {
  repository: {
    id: string
    githubOwner: string
    githubRepo: string
    localPath: string
    isBare: boolean
    paused: boolean
    issuesReconciledAt: string | null
  }
}) {
  return (
    <article className="min-w-0 rounded-[0.9rem] border border-[#dbe3ef] bg-white p-[1.35rem] shadow-[0_10px_30px_rgb(15_23_42_/_5%)]">
      <div className="flex items-center justify-between gap-4">
        <span className="truncate text-[0.85rem] font-[650] text-slate-500">
          {repository.githubOwner}
        </span>
        <span
          className={`shrink-0 rounded-full px-[0.55rem] py-[0.2rem] text-[0.7rem] font-[750] tracking-[0.04em] uppercase ${repository.paused ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800"}`}
        >
          {repository.paused ? "Paused" : "Active"}
        </span>
      </div>
      <h2 className="my-[0.2rem] mb-[1.4rem] wrap-anywhere text-2xl tracking-[-0.025em]">
        <a
          className="text-slate-900 hover:underline"
          href={`https://github.com/${repository.githubOwner}/${repository.githubRepo}`}
        >
          {repository.githubRepo}
        </a>
      </h2>
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
      <div className="mt-5 border-t border-slate-100 pt-4">
        <h3 className="m-0 mb-2 text-[0.68rem] font-[750] tracking-[0.08em] text-slate-400 uppercase">
          Ready-labeled issues
        </h3>
        {repository.issuesReconciledAt === null ? (
          <p className="m-0 text-sm text-slate-500">Not refreshed yet.</p>
        ) : (
          <Suspense fallback={<RepositoryIssuesSkeleton />}>
            <RepositoryIssues repositoryId={repository.id} />
          </Suspense>
        )}
      </div>
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
