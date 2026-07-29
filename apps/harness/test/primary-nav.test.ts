import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

describe("primary Home / Kanban navigation", () => {
  test("root chrome exposes Home and Kanban Link controls", () => {
    const source = rootSource()
    expect(source).toContain('aria-label="Primary"')
    expect(source).toContain('to="/"')
    expect(source).toContain('to="/kanban"')
    expect(source).toMatch(/Home\s*<\/Link>/)
    expect(source).toMatch(/Kanban\s*<\/Link>/)
  })

  test("groups Home, Kanban, and Settings in one right-aligned control cluster", () => {
    const source = rootSource()
    const clusterMarker =
      'className="ml-auto flex items-center gap-2 self-center"'
    expect(source).toContain(clusterMarker)
    // ml-auto lives on the group, not only on Settings.
    expect(source).not.toMatch(
      /className="ml-auto inline-flex items-center gap-2 border/,
    )

    // Home and Kanban are passed as leading into SettingsButton (same cluster).
    const settingsBlock = source.slice(
      source.indexOf("<SettingsButton"),
      source.indexOf("</nav>"),
    )
    expect(settingsBlock).toContain("leading={")
    expect(settingsBlock).toContain('to="/"')
    expect(settingsBlock).toContain('to="/kanban"')
    expect(settingsBlock).toContain("<HomeNavIcon />")
    expect(settingsBlock).toContain("<KanbanNavIcon />")
    const homeIdx = settingsBlock.indexOf('to="/"')
    const kanbanIdx = settingsBlock.indexOf('to="/kanban"')
    expect(homeIdx).toBeGreaterThan(-1)
    expect(kanbanIdx).toBeGreaterThan(homeIdx)

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

  test("Home and Kanban use stroke icons matching Settings icon language", () => {
    const source = rootSource()
    expect(source).toContain("function HomeNavIcon()")
    expect(source).toContain("function KanbanNavIcon()")
    expect(source).toContain("<HomeNavIcon />")
    expect(source).toContain("<KanbanNavIcon />")
    // Icons: aria-hidden, size-3.5, stroke currentColor (same as Settings gear).
    for (const iconFn of ["HomeNavIcon", "KanbanNavIcon"] as const) {
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
    // Slice from the SettingsButton leading prop through the first destination.
    const homeSwitcherLink = source.slice(
      source.indexOf("leading={"),
      source.indexOf('to="/kanban"'),
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
    // Both destinations are client Links, not raw <a href> only.
    expect(source).not.toMatch(/<a\s+href=["']\/kanban["']/)
    expect(source).not.toMatch(/<a\s+href=["']\/["']/)
  })

  test("shared nav lives in root layout so Home and Kanban both inherit it", () => {
    const source = rootSource()
    const rootComponent = source.slice(
      source.indexOf("function RootComponent("),
    )
    expect(rootComponent).toContain('to="/kanban"')
    expect(rootComponent).toMatch(/Home\s*<\/Link>/)
    expect(rootComponent).toMatch(/Kanban\s*<\/Link>/)
    expect(rootComponent).toContain("<Outlet />")
    expect(rootComponent.indexOf("Home")).toBeLessThan(
      rootComponent.indexOf("<Outlet />"),
    )
  })
})
