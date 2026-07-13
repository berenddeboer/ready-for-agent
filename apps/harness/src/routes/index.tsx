import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Suspense } from "react"
import { createClient } from "@ready-for-agent/graphql-client"

const graphql = createClient({ url: "/graphql" })

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
      },
    })
    return result.repositories
  },
}

export const Route = createFileRoute("/")({
  component: HomePage,
})

function HomePage() {
  return (
    <main>
      <header className="page-header">
        <p className="eyebrow">Workspace</p>
        <h1>Configured repositories</h1>
        <p className="muted">
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
      <div className="empty-state">
        <h2>No repositories configured</h2>
        <p className="muted">Add a repository with the CLI to see it here.</p>
      </div>
    )
  }

  return (
    <section className="repository-grid" aria-label="Configured repositories">
      {repositories.map((repository) => (
        <article className="repository-card" key={repository.id}>
          <div className="repository-card__topline">
            <span className="repository-owner">{repository.githubOwner}</span>
            <span
              className={`status ${repository.paused ? "status--paused" : "status--active"}`}
            >
              {repository.paused ? "Paused" : "Active"}
            </span>
          </div>
          <h2>
            <a
              href={`https://github.com/${repository.githubOwner}/${repository.githubRepo}`}
            >
              {repository.githubRepo}
            </a>
          </h2>
          <dl className="repository-details">
            <div>
              <dt>Local path</dt>
              <dd title={repository.localPath}>{repository.localPath}</dd>
            </div>
            <div>
              <dt>Checkout</dt>
              <dd>{repository.isBare ? "Bare repository" : "Working tree"}</dd>
            </div>
          </dl>
        </article>
      ))}
    </section>
  )
}

function RepositoryCardsSkeleton() {
  return (
    <section
      className="repository-grid"
      aria-label="Loading repositories"
      aria-busy="true"
    >
      {[0, 1, 2].map((item) => (
        <div className="repository-card repository-card--loading" key={item}>
          <span className="skeleton skeleton--short" />
          <span className="skeleton skeleton--title" />
          <span className="skeleton skeleton--line" />
        </div>
      ))}
    </section>
  )
}
