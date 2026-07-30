import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const stylesSource = () =>
  readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")

describe("primary Home / Repos / Kanban / Completed navigation", () => {
  test("root chrome exposes Home, Repos, Kanban, and Completed Link controls", () => {
    const source = rootSource()
    expect(source).toContain('aria-label="Primary"')
    expect(source).toContain('to="/"')
    expect(source).toContain('to="/repos"')
    expect(source).toContain('to="/kanban"')
    expect(source).toContain('to="/completed"')
    expect(source).toMatch(/Home\s*<\/Link>/)
    expect(source).toMatch(/Repos\s*<\/Link>/)
    expect(source).toMatch(/Kanban\s*<\/Link>/)
    expect(source).toMatch(/Completed\s*<\/Link>/)
  })

  test("primary nav uses a full-width bold black divider on every route", () => {
    // Issue #670: masthead 0.5rem rule moves under Clanker Harness nav (all routes).
    const root = rootSource()
    const styles = stylesSource()
    const navOpen = root.indexOf('aria-label="Primary"')
    expect(navOpen).toBeGreaterThan(-1)
    const navTag = root.slice(navOpen - 80, navOpen + 160)
    expect(navTag).toContain("primary-nav")
    // Thin Tailwind border is no longer the nav rule.
    expect(navTag).not.toMatch(/border-b-2\s+border-ink/)
    // Shared weight matches the former Kanban masthead separator.
    const primaryNavBlock = styles.slice(
      styles.indexOf(".primary-nav {"),
      styles.indexOf("}", styles.indexOf(".primary-nav {")) + 1,
    )
    expect(primaryNavBlock).toContain(".primary-nav {")
    expect(primaryNavBlock).toContain(
      "border-bottom: 0.5rem solid var(--color-ink)",
    )
    // Divider lives in root layout above Outlet — every child route inherits it.
    const rootComponent = root.slice(root.indexOf("function RootComponent("))
    expect(rootComponent.indexOf("primary-nav")).toBeGreaterThan(-1)
    expect(rootComponent.indexOf("primary-nav")).toBeLessThan(
      rootComponent.indexOf("<Outlet />"),
    )
  })

  test("groups Home, Repos, Kanban, Completed, and Settings in one right-aligned control cluster", () => {
    const source = rootSource()
    const clusterMarker =
      'className="ml-auto flex items-center gap-2 self-center"'
    expect(source).toContain(clusterMarker)
    // ml-auto lives on the group, not only on Settings.
    expect(source).not.toMatch(
      /className="ml-auto inline-flex items-center gap-2 border/,
    )

    // Destinations are passed as leading into SettingsButton (same cluster).
    const settingsBlock = source.slice(
      source.indexOf("<SettingsButton"),
      source.indexOf("</nav>"),
    )
    expect(settingsBlock).toContain("leading={")
    expect(settingsBlock).toContain('to="/"')
    expect(settingsBlock).toContain('to="/repos"')
    expect(settingsBlock).toContain('to="/kanban"')
    expect(settingsBlock).toContain('to="/completed"')
    expect(settingsBlock).toContain("<HomeNavIcon />")
    expect(settingsBlock).toContain("<ReposNavIcon />")
    expect(settingsBlock).toContain("<KanbanNavIcon />")
    expect(settingsBlock).toContain("<CompletedNavIcon />")
    const homeIdx = settingsBlock.indexOf('to="/"')
    const reposIdx = settingsBlock.indexOf('to="/repos"')
    const kanbanIdx = settingsBlock.indexOf('to="/kanban"')
    const completedIdx = settingsBlock.indexOf('to="/completed"')
    expect(homeIdx).toBeGreaterThan(-1)
    expect(reposIdx).toBeGreaterThan(homeIdx)
    expect(kanbanIdx).toBeGreaterThan(reposIdx)
    // Completed sits after Kanban (and after Repos).
    expect(completedIdx).toBeGreaterThan(kanbanIdx)

    // Cluster wraps leading destinations and the Settings trigger.
    const clusterStart = source.indexOf(
      '<div className="ml-auto flex items-center gap-2 self-center">',
    )
    expect(clusterStart).toBeGreaterThan(-1)
    const cluster = source.slice(
      clusterStart,
      source.indexOf("</div>", clusterStart),
    )
    expect(cluster).toContain("{leading}")
    expect(cluster).toContain("Settings")
    expect(cluster).toContain("primaryNavActionClassName")

    // Brand title stays outside the action cluster (left side).
    const brandIdx = source.indexOf("Clanker Harness")
    expect(brandIdx).toBeGreaterThan(-1)
    expect(brandIdx).toBeLessThan(source.indexOf("<SettingsButton"))
  })

  test("Home, Repos, Kanban, and Completed use stroke icons matching Settings icon language", () => {
    const source = rootSource()
    expect(source).toContain("function HomeNavIcon()")
    expect(source).toContain("function ReposNavIcon()")
    expect(source).toContain("function KanbanNavIcon()")
    expect(source).toContain("function CompletedNavIcon()")
    expect(source).toContain("<HomeNavIcon />")
    expect(source).toContain("<ReposNavIcon />")
    expect(source).toContain("<KanbanNavIcon />")
    expect(source).toContain("<CompletedNavIcon />")
    // Icons: aria-hidden, size-3.5, stroke currentColor (same as Settings gear).
    for (const iconFn of [
      "HomeNavIcon",
      "ReposNavIcon",
      "KanbanNavIcon",
      "CompletedNavIcon",
    ] as const) {
      const start = source.indexOf(`function ${iconFn}(`)
      expect(start).toBeGreaterThan(-1)
      const body = source.slice(start, source.indexOf("\n}", start) + 2)
      expect(body).toContain('aria-hidden="true"')
      expect(body).toContain('className="size-3.5"')
      expect(body).toContain('stroke="currentColor"')
      expect(body).toContain('strokeWidth="2"')
      expect(body).toContain('fill="none"')
    }
  })

  test("uses TanStack Router Link with active route styling", () => {
    const source = rootSource()
    expect(source).toContain('from "@tanstack/react-router"')
    expect(source).toContain("primaryNavLinkClassName")
    expect(source).toContain("primaryNavLinkInactiveClassName")
    expect(source).toContain("primaryNavLinkActiveClassName")
    expect(source).toContain(
      "inactiveProps={{ className: primaryNavLinkInactiveClassName }}",
    )
    expect(source).toContain(
      "activeProps={{ className: primaryNavLinkActiveClassName }}",
    )
    // Home nav control (not the brand title Link) must use exact matching.
    // Slice from the SettingsButton leading prop through the first non-Home destination.
    const homeSwitcherLink = source.slice(
      source.indexOf("leading={"),
      source.indexOf('to="/repos"'),
    )
    expect(homeSwitcherLink).toContain('to="/"')
    expect(homeSwitcherLink).toContain("activeOptions={{ exact: true }}")
    // Shared base must not carry exclusive active/inactive visual tokens —
    // Router merges className with active/inactive props.
    const sharedClassDecl = source.match(
      /const primaryNavLinkClassName =\s*\n?\s*"([^"]+)"/,
    )
    expect(sharedClassDecl).not.toBeNull()
    const sharedClasses = sharedClassDecl?.[1] ?? ""
    for (const exclusive of [
      "border-ink",
      "bg-ink",
      "text-paper",
      "border-rule-2",
      "bg-panel",
      "text-ink-2",
      "text-ink-faint",
      "text-ink",
      "bg-paper-2",
      "hover:border-ink-soft",
      "hover:bg-paper-2",
      "hover:text-ink-2",
    ]) {
      expect(sharedClasses.split(/\s+/)).not.toContain(exclusive)
    }
    // Shared layout includes icon gap so label + icon share one baseline.
    expect(sharedClasses.split(/\s+/)).toContain("gap-2")
    expect(source).toContain(
      'const primaryNavLinkInactiveClassName =\n  "border-rule-2 bg-panel text-ink-faint hover:border-ink-soft hover:bg-paper-2 hover:text-ink-2"',
    )
    // Soft selected state — not the old solid black/ink filled pill.
    expect(source).toContain(
      'const primaryNavLinkActiveClassName = "border-ink bg-paper-2 text-ink"',
    )
    expect(source).not.toContain(
      'const primaryNavLinkActiveClassName = "border-ink bg-ink text-paper"',
    )
    // Settings stays in the inactive-nav visual family (not a selected route).
    expect(source).toContain("primaryNavActionClassName")
    expect(source).toContain("className={primaryNavActionClassName}")
    expect(source).toMatch(
      /const primaryNavActionClassName =\s*\n?\s*"[^"]*text-ink-faint[^"]*"/,
    )
    // Destinations are client Links, not raw <a href> only.
    expect(source).not.toMatch(/<a\s+href=["']\/kanban["']/)
    expect(source).not.toMatch(/<a\s+href=["']\/repos["']/)
    expect(source).not.toMatch(/<a\s+href=["']\/completed["']/)
    expect(source).not.toMatch(/<a\s+href=["']\/["']/)
  })

  test("shared nav lives in root layout so Home, Repos, Kanban, and Completed inherit it", () => {
    const source = rootSource()
    const rootComponent = source.slice(
      source.indexOf("function RootComponent("),
    )
    expect(rootComponent).toContain('to="/repos"')
    expect(rootComponent).toContain('to="/kanban"')
    expect(rootComponent).toContain('to="/completed"')
    expect(rootComponent).toMatch(/Home\s*<\/Link>/)
    expect(rootComponent).toMatch(/Repos\s*<\/Link>/)
    expect(rootComponent).toMatch(/Kanban\s*<\/Link>/)
    expect(rootComponent).toMatch(/Completed\s*<\/Link>/)
    expect(rootComponent).toContain("<Outlet />")
    expect(rootComponent.indexOf("Home")).toBeLessThan(
      rootComponent.indexOf("<Outlet />"),
    )
  })
})
