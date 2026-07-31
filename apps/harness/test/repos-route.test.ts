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

  test("primary nav places Home before Repos before Completed", () => {
    const source = rootSource()
    const navBlock = source.slice(
      source.indexOf('aria-label="Primary"'),
      source.indexOf("</nav>"),
    )
    const homeIdx = navBlock.indexOf('to="/"')
    const reposIdx = navBlock.indexOf('to="/repos"')
    const completedIdx = navBlock.indexOf('to="/completed"')
    expect(homeIdx).toBeGreaterThan(-1)
    expect(reposIdx).toBeGreaterThan(homeIdx)
    expect(completedIdx).toBeGreaterThan(reposIdx)
    expect(navBlock).toMatch(/Home\s*<\/Link>/)
    expect(navBlock).toMatch(/Repos\s*<\/Link>/)
    expect(navBlock).not.toMatch(/Kanban\s*<\/Link>/)
    // Active styling is shared with other primary destinations.
    const reposLink = navBlock.slice(reposIdx, completedIdx)
    expect(reposLink).toContain("mastPlateClassName")
    expect(reposLink).toContain('activeProps={{ "aria-current": "page" }}')
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
