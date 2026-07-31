import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ParentIssueActionsMenu,
  isParentImplementAllWithAutoMergeEligible,
} from "../src/parent-issue-actions-menu.js"
import { describe, expect, test } from "bun:test"

describe("isParentImplementAllWithAutoMergeEligible", () => {
  const leaf = (issueNumber: number, blockedBy: readonly unknown[] = []) => ({
    issueNumber,
    hasChildren: false,
    blockedBy,
  })

  test("allows one or more open leaf children", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2)],
        directChildren: [leaf(2)],
        workItemsLoading: false,
      }),
    ).toBe(true)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2), leaf(3)],
        directChildren: [leaf(2), leaf(3)],
        workItemsLoading: false,
      }),
    ).toBe(true)
  })

  test("hides unsupported hierarchy for open or closed direct children with children", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [{ issueNumber: 2, hasChildren: true, blockedBy: [] }],
        directChildren: [{ hasChildren: true }],
        workItemsLoading: false,
      }),
    ).toBe(false)

    // Closed mid-level child still fails server hierarchy; hide the action.
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(3)],
        directChildren: [{ hasChildren: true }, { hasChildren: false }],
        workItemsLoading: false,
      }),
    ).toBe(false)
  })

  test("hides while work items are loading and when there are no open children", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2)],
        directChildren: [leaf(2)],
        workItemsLoading: true,
      }),
    ).toBe(false)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [],
        directChildren: [{ hasChildren: false }],
        workItemsLoading: false,
      }),
    ).toBe(false)
  })
})

describe("ParentIssueActionsMenu", () => {
  test("renders accessible Actions control for the Parent Issue", () => {
    const html = renderToStaticMarkup(
      <ParentIssueActionsMenu
        parentIssueNumber={42}
        menuId="issue-parent-42"
        pending={false}
        errorMessage={null}
        onImplementAllWithAutoMerge={() => undefined}
      />,
    )
    expect(html).toContain('aria-label="Actions for parent issue #42"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain("data-parent-issue-menu")
    // Closed by default; sole action is Implement all with auto-merge only.
    expect(html).not.toContain("Implement now")
    expect(html).not.toContain("Queue")
  })

  test("shows parent-level error alert without partial-success copy", () => {
    const html = renderToStaticMarkup(
      <ParentIssueActionsMenu
        parentIssueNumber={7}
        menuId="issue-parent-7"
        pending={true}
        errorMessage="Could not start Implement all with auto-merge. Refresh the issues and try again."
        onImplementAllWithAutoMerge={() => undefined}
      />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain("Could not start Implement all with auto-merge")
    // In-flow alarm Banner (not absolute under kebab).
    expect(html).toContain("banner--compact")
    expect(html).toContain("parent-issue-error")
    expect(html).toContain("banner-tag")
    expect(html).toContain("Error")
    expect(html).not.toContain("absolute top-full right-0 z-10 mt-1 w-56")
  })

  test("menu source exposes sole menuitem label Implement all with auto-merge", () => {
    // CI unit tests do not install Playwright browser binaries; lock the
    // accessible menu contract from the component source instead of chromium.
    const source = readFileSync(
      join(import.meta.dir, "../src/parent-issue-actions-menu.tsx"),
      "utf8",
    )
    expect(source).toContain('role="menu"')
    expect(source).toContain('role="menuitem"')
    expect(source).toContain("Implement all with auto-merge")
    expect(source).not.toContain("Implement now")
    expect(source).not.toContain('"Queue"')
    expect(source.match(/role="menuitem"/g)?.length).toBe(1)
  })

  test("menu uses Interchange mono uppercase menuitems and icon-btn trigger", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/parent-issue-actions-menu.tsx"),
      "utf8",
    )
    // §4.10 / phase 4: icon-btn trigger; mono uppercase items (no Ledger shadow).
    expect(source).toContain('className="icon-btn"')
    expect(source).toMatch(
      /role="menu"[\s\S]*?border-2 border-ink[\s\S]*?role="menuitem"/,
    )
    expect(source).toContain("font-mono")
    expect(source).toContain("uppercase")
    expect(source).not.toContain("shadow-[")
  })
})

describe("ParentIssueGroup control order", () => {
  test("chevron sits left of kebab; kebab is rightmost control", () => {
    // Parent row lives in the dashboard route; lock DOM order without a browser.
    const source = readFileSync(
      join(import.meta.dir, "../src/routes/index.tsx"),
      "utf8",
    )
    const groupStart = source.indexOf("function ParentIssueGroup")
    expect(groupStart).toBeGreaterThanOrEqual(0)
    const groupEnd = source.indexOf("function RepositoryIssueRow", groupStart)
    expect(groupEnd).toBeGreaterThan(groupStart)
    const group = source.slice(groupStart, groupEnd)

    // Anchor on the UI closed-count label, not the closedChildren prop name.
    const closedLabel = group.indexOf("childIssues.length} closed")
    const chevron = group.indexOf("parent-issue-chevron")
    const kebab = group.indexOf("<ParentIssueActionsMenu")
    expect(closedLabel).toBeGreaterThanOrEqual(0)
    expect(chevron).toBeGreaterThan(closedLabel)
    expect(kebab).toBeGreaterThan(chevron)

    // Closed-count mono chip sits left of the chevron and kebab.
    expect(group).toContain("parent-issue-closed-count")
    expect(group).toContain("parent-issue-summary-actions")
    expect(group).not.toMatch(/flex shrink-0 items-center gap-1\.5 font-mono/)
  })
})
