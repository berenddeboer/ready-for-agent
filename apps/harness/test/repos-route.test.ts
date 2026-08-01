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

  test("Repos sits between Pipeline and Completed in the Jobs switcher", () => {
    const root = rootSource()
    const switcher = readFileSync(
      join(import.meta.dir, "../src/jobs-view-switcher.tsx"),
      "utf8",
    )
    // Mast no longer carries a Repos plate.
    const navBlock = root.slice(
      root.indexOf('aria-label="Primary"'),
      root.indexOf("</nav>"),
    )
    expect(navBlock).not.toContain('to="/repos"')
    expect(navBlock).not.toMatch(/Repos\s*<\/Link>/)
    expect(navBlock).toContain("Settings")

    const tabs = switcher.slice(
      switcher.indexOf('aria-label="Jobs"'),
      switcher.indexOf("<JobsRepositoryFilters"),
    )
    const pipelineIdx = tabs.indexOf('to="/"')
    const reposIdx = tabs.indexOf('to="/repos"')
    const completedIdx = tabs.indexOf('to="/completed"')
    expect(pipelineIdx).toBeGreaterThan(-1)
    expect(reposIdx).toBeGreaterThan(pipelineIdx)
    expect(completedIdx).toBeGreaterThan(reposIdx)
    expect(tabs).toContain("<ReposTabIcon")
    expect(tabs).toMatch(/Repos\s*<\/Link>/)
  })

  test("Repos page body keeps the reading-width cap", () => {
    const source = reposSource()
    expect(source).toContain("max-w-[88rem]")
    expect(source).toMatch(/className="[^"]*max-w-\[88rem\][^"]*"/)
  })

  test("home shows blank slate with zero repos and board with one or more", () => {
    const source = homeSource()
    const homeContent = source.slice(
      source.indexOf("function HomeContent()"),
      source.indexOf("function EmptyRepositoriesBlankSlate()"),
    )
    expect(homeContent).toContain("(repositories ?? []).length === 0")
    expect(homeContent).toContain("<EmptyRepositoriesBlankSlate />")
    expect(homeContent).toContain("<KanbanBoard />")
    // Soft-fail repositories so a load error cannot unmount home.
    expect(homeContent).toContain("useQuery(repositoriesQuery)")
    expect(homeContent).not.toContain("useSuspenseQuery(repositoriesQuery)")
    // Membership SSE stays on home for blank-slate ↔ board live gate.
    expect(source).toContain("function HomeRepositoryMembershipLive()")
    expect(source).toContain("<HomeRepositoryMembershipLive />")
    expect(source).toContain("followRepositoryMembershipLive")
    // Old home Jobs surface is gone.
    expect(source).not.toContain("function JobsCard()")
    expect(source).not.toContain("function HomeBody()")
    expect(source).not.toContain("function HomeLiveUpdates()")
  })

  test("repos empty state reuses EmptyRepositoriesBlankSlate", () => {
    const source = homeSource()
    expect(source).toContain("function EmptyRepositoriesBlankSlate()")
    const cards = source.slice(
      source.indexOf("export function RepositoryCards()"),
      source.indexOf("function AddRepositoryGuidance("),
    )
    const emptyStart = cards.indexOf("if (repositories.length === 0)")
    const emptyReturn = cards.indexOf("return (", emptyStart)
    const populatedReturn = cards.indexOf("return (", emptyReturn + 1)
    const emptyBranch = cards.slice(emptyStart, populatedReturn)
    expect(emptyBranch).toContain("<EmptyRepositoriesBlankSlate />")
    expect(emptyBranch).not.toContain("<AddRepositoryGuidance")
  })
})
