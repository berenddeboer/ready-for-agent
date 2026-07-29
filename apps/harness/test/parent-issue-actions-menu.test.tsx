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

  test("allows one or more open leaf children, including blocked and unfinished", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2)],
        directChildren: [leaf(2)],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(true)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2), leaf(3)],
        directChildren: [leaf(2), leaf(3)],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(true)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2, [{ issueNumber: 1 }]), leaf(3)],
        directChildren: [leaf(2, [{ issueNumber: 1 }]), leaf(3)],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(true)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2, [{ issueNumber: 1 }])],
        directChildren: [leaf(2, [{ issueNumber: 1 }])],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(true)

    // Existing unfinished Work Items are adopted; action stays available.
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2)],
        directChildren: [leaf(2)],
        workItems: [{ issueNumber: 2, state: "CREATE_WORKTREE" }],
        workItemsLoading: false,
      }),
    ).toBe(true)
  })

  test("stays available when some or all open children already have unfinished work", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2), leaf(3)],
        directChildren: [leaf(2), leaf(3)],
        workItems: [{ issueNumber: 2, state: "CREATE_WORKTREE" }],
        workItemsLoading: false,
      }),
    ).toBe(true)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2), leaf(3)],
        directChildren: [leaf(2), leaf(3)],
        workItems: [
          { issueNumber: 2, state: "CREATE_WORKTREE" },
          { issueNumber: 3, state: "IMPLEMENT" },
        ],
        workItemsLoading: false,
      }),
    ).toBe(true)
  })

  test("hides unsupported hierarchy for open or closed direct children with children", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [{ issueNumber: 2, hasChildren: true, blockedBy: [] }],
        directChildren: [{ hasChildren: true }],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(false)

    // Closed mid-level child still fails server hierarchy; hide the action.
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(3)],
        directChildren: [{ hasChildren: true }, { hasChildren: false }],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(false)
  })

  test("stays available for Needs Human unfinished children (adopt Merge Mode Only)", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2)],
        directChildren: [leaf(2)],
        workItems: [{ issueNumber: 2, state: "NEEDS_HUMAN" }],
        workItemsLoading: false,
      }),
    ).toBe(true)
  })

  test("allows complete, failed, and abandoned child history", () => {
    for (const state of ["COMPLETE", "FAILED", "ABANDONED"] as const) {
      expect(
        isParentImplementAllWithAutoMergeEligible({
          openChildren: [leaf(2)],
          directChildren: [leaf(2)],
          workItems: [{ issueNumber: 2, state }],
          workItemsLoading: false,
        }),
      ).toBe(true)
    }
  })

  test("hides while work items are loading and when there are no open children", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2)],
        directChildren: [leaf(2)],
        workItems: [],
        workItemsLoading: true,
      }),
    ).toBe(false)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [],
        directChildren: [{ hasChildren: false }],
        workItems: [],
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

  test("menu shell resets inherited mono/uppercase styles to match other app menus", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/parent-issue-actions-menu.tsx"),
      "utf8",
    )
    // Other menus (leaf issue, repository card) use plain sans menuitems.
    // Explicit resets keep the kebab menu correct if a parent stamp/label wraps it.
    expect(source).toMatch(
      /role="menu"[\s\S]*?font-sans[\s\S]*?normal-case[\s\S]*?tracking-normal/,
    )
    expect(source).toContain(
      'className="block w-full px-3 py-2 text-left text-sm font-medium text-ink-2 hover:bg-paper-2"',
    )
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
    const chevron = group.indexOf("group-open:rotate-180")
    const kebab = group.indexOf("<ParentIssueActionsMenu")
    expect(closedLabel).toBeGreaterThanOrEqual(0)
    expect(chevron).toBeGreaterThan(closedLabel)
    expect(kebab).toBeGreaterThan(chevron)

    // Stamp mono/uppercase applies only to the closed count, not the controls.
    // Chevron keeps text-ink-faint for currentColor without re-wrapping the menu.
    expect(group).toMatch(
      /font-mono text-xs font-semibold tracking-\[0\.1em\] text-ink-faint uppercase[\s\S]*?closed/,
    )
    expect(group).toContain(
      "size-3.5 text-ink-faint transition-transform group-open:rotate-180",
    )
    expect(group).not.toMatch(/flex shrink-0 items-center gap-1\.5 font-mono/)
  })
})
