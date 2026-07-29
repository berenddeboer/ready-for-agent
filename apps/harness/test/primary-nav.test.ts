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
    expect(source).toMatch(/>\s*Home\s*<\/Link>/)
    expect(source).toMatch(/>\s*Kanban\s*<\/Link>/)
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
    // Slice from the switcher container through the first destination only.
    const homeSwitcherLink = source.slice(
      source.indexOf('<div className="flex items-center gap-2 self-center">'),
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
      "hover:border-ink-soft",
      "hover:bg-paper-2",
    ]) {
      expect(sharedClasses.split(/\s+/)).not.toContain(exclusive)
    }
    expect(source).toContain(
      'const primaryNavLinkInactiveClassName =\n  "border-rule-2 bg-panel text-ink-2 hover:border-ink-soft hover:bg-paper-2"',
    )
    expect(source).toContain(
      'const primaryNavLinkActiveClassName = "border-ink bg-ink text-paper"',
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
    expect(rootComponent).toMatch(/>\s*Home\s*<\/Link>/)
    expect(rootComponent).toMatch(/>\s*Kanban\s*<\/Link>/)
    expect(rootComponent).toContain("<Outlet />")
    expect(rootComponent.indexOf("Home")).toBeLessThan(
      rootComponent.indexOf("<Outlet />"),
    )
  })
})
