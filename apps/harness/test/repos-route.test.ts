import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const reposSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/repos.tsx"), "utf8")

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const routeTreeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routeTree.gen.ts"), "utf8")

describe("/repos route", () => {
  test("is a dedicated TanStack file route that renders repository cards", () => {
    const source = reposSource()
    expect(source).toContain('createFileRoute("/repos")')
    expect(source).toContain("<RepositoryCards />")
    expect(source).toContain("<RepositoryCardsSkeleton />")
    expect(source).toContain('from "./index.js"')
  })

  test("is registered in the generated route tree", () => {
    const source = routeTreeSource()
    expect(source).toContain("from './routes/repos'")
    expect(source).toContain("id: '/repos'")
    expect(source).toContain("path: '/repos'")
    expect(source).toContain("'/repos': typeof ReposRoute")
  })

  test("primary nav places Repos immediately after Home and before Kanban", () => {
    const source = rootSource()
    const settingsBlock = source.slice(
      source.indexOf("<SettingsButton"),
      source.indexOf("</nav>"),
    )
    const homeIdx = settingsBlock.indexOf('to="/"')
    const reposIdx = settingsBlock.indexOf('to="/repos"')
    const kanbanIdx = settingsBlock.indexOf('to="/kanban"')
    expect(homeIdx).toBeGreaterThan(-1)
    expect(reposIdx).toBeGreaterThan(homeIdx)
    expect(kanbanIdx).toBeGreaterThan(reposIdx)
    expect(settingsBlock).toMatch(/Repos\s*<\/Link>/)
    // Active styling is shared with other primary destinations.
    const reposLink = settingsBlock.slice(reposIdx, kanbanIdx)
    expect(reposLink).toContain("primaryNavLinkClassName")
    expect(reposLink).toContain(
      "activeProps={{ className: primaryNavLinkActiveClassName }}",
    )
  })

  test("Home no longer renders repository cards or add-repository guidance", () => {
    const source = homeSource()
    const homeBody = source.slice(
      source.indexOf("function HomeBody()"),
      source.indexOf("function CommittedPullRequestsDashboard()"),
    )
    expect(homeBody).toContain("<CommittedPullRequestsDashboard />")
    expect(homeBody).toContain("<JobsCard />")
    expect(homeBody).not.toContain("<RepositoryCards")
    expect(homeBody).not.toContain("AddRepositoryGuidance")
    expect(homeBody).not.toContain('aria-label="Configured repositories"')
    // Empty-repo early return that replaced the dashboard is gone.
    expect(homeBody).not.toContain("repositories.length === 0")
    expect(homeBody).not.toContain("return <RepositoryCards />")
  })

  test("Home keeps Jobs and dashboard live updates without repository management", () => {
    const source = homeSource()
    expect(source).toContain("function HomeLiveUpdates()")
    expect(source).toContain("<HomeLiveUpdates />")
    const homeLive = source.slice(
      source.indexOf("function HomeLiveUpdates()"),
      source.indexOf("function HomeBody()"),
    )
    // Soft-fail: do not suspense-throw repositories errors over the dashboard.
    expect(homeLive).toContain("useQuery(repositoriesQuery)")
    expect(homeLive).not.toContain("useSuspenseQuery(repositoriesQuery)")
    expect(homeLive).toContain("followRepositoryMembershipLive")
    expect(homeLive).toContain("onLiveUpdatesUnavailable")
    expect(homeLive).toContain("liveUpdatesWarningPresentation")
    expect(homeLive).toContain("followRepositoryIssuesLive")
    expect(homeLive).toContain("followRepositoryWorkItemsLive")
    // Open PR header counts are repository-card chrome only.
    expect(homeLive).not.toContain("followOpenPullRequestCountLive")
  })

  test("JobsCard soft-fails repositories so Home dashboard stays mounted", () => {
    const source = homeSource()
    const jobsCard = source.slice(
      source.indexOf("function JobsCard()"),
      source.indexOf("function JobsCardSkeleton()"),
    )
    expect(jobsCard).toContain("useQuery(repositoriesQuery)")
    expect(jobsCard).not.toContain("useSuspenseQuery(repositoriesQuery)")
    expect(jobsCard).toContain("repositoriesFailed")
    expect(jobsCard).toContain("Could not load jobs. Please try again.")
    // No Suspense wrapper around Jobs on Home (no suspense boundary needed).
    const homeBody = source.slice(
      source.indexOf("function HomeBody()"),
      source.indexOf("function CommittedPullRequestsDashboard()"),
    )
    expect(homeBody).toContain("<JobsCard />")
    expect(homeBody).not.toContain("Suspense fallback={<JobsCardSkeleton />}")
  })

  test("empty Jobs card links to /repos for add-repository discoverability", () => {
    const source = homeSource()
    const jobsCard = source.slice(
      source.indexOf("function JobsCard()"),
      source.indexOf("function JobsCardSkeleton()"),
    )
    const emptyBranch = jobsCard.slice(
      jobsCard.indexOf("repositories.length === 0"),
      jobsCard.indexOf("if (loading && activeItems.length === 0)"),
    )
    expect(emptyBranch).toContain('to="/repos"')
    expect(emptyBranch).toContain("Add a repository")
    expect(emptyBranch).toContain("to see jobs.")
  })
})
