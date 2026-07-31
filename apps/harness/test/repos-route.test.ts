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

  test("primary nav places Repos before Kanban (home)", () => {
    const source = rootSource()
    const settingsBlock = source.slice(
      source.indexOf("<SettingsButton"),
      source.indexOf("</nav>"),
    )
    const reposIdx = settingsBlock.indexOf('to="/repos"')
    const kanbanIdx = settingsBlock.indexOf('to="/"')
    expect(reposIdx).toBeGreaterThan(-1)
    expect(kanbanIdx).toBeGreaterThan(reposIdx)
    expect(settingsBlock).toMatch(/Repos\s*<\/Link>/)
    expect(settingsBlock).toMatch(/Kanban\s*<\/Link>/)
    // Active styling is shared with other primary destinations.
    const reposLink = settingsBlock.slice(reposIdx, kanbanIdx)
    expect(reposLink).toContain("primaryNavLinkClassName")
    expect(reposLink).toContain(
      "activeProps={{ className: primaryNavLinkActiveClassName }}",
    )
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
