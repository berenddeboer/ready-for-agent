import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ParentIssueActionsMenu,
  isParentImplementAllWithAutoMergeEligible,
} from "../src/parent-issue-actions-menu.js"
import { describe, expect, test } from "bun:test"

describe("isParentImplementAllWithAutoMergeEligible", () => {
  const leaf = (
    githubIssueNumber: number,
    blockedBy: readonly unknown[] = [],
  ) => ({
    githubIssueNumber,
    hasChildren: false,
    blockedBy,
  })

  test("allows one or more open leaf children without unfinished work, including blocked", () => {
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
        openChildren: [leaf(2, [{ githubIssueNumber: 1 }]), leaf(3)],
        directChildren: [leaf(2, [{ githubIssueNumber: 1 }]), leaf(3)],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(true)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2, [{ githubIssueNumber: 1 }])],
        directChildren: [leaf(2, [{ githubIssueNumber: 1 }])],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(true)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2)],
        directChildren: [leaf(2)],
        workItems: [{ githubIssueNumber: 2, state: "CREATE_WORKTREE" }],
        workItemsLoading: false,
      }),
    ).toBe(false)
  })

  test("stays available when some open children already have unfinished work", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2), leaf(3)],
        directChildren: [leaf(2), leaf(3)],
        workItems: [{ githubIssueNumber: 2, state: "CREATE_WORKTREE" }],
        workItemsLoading: false,
      }),
    ).toBe(true)
  })

  test("hides unsupported hierarchy for open or closed direct children with children", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [
          { githubIssueNumber: 2, hasChildren: true, blockedBy: [] },
        ],
        directChildren: [
          { githubIssueNumber: 2, hasChildren: true, blockedBy: [] },
        ],
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

  test("blocks Needs Human (terminal, non-retryable) to match server unfinished rules", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [leaf(2)],
        directChildren: [leaf(2)],
        workItems: [{ githubIssueNumber: 2, state: "NEEDS_HUMAN" }],
        workItemsLoading: false,
      }),
    ).toBe(false)
  })

  test("allows complete, failed, and abandoned child history", () => {
    for (const state of ["COMPLETE", "FAILED", "ABANDONED"] as const) {
      expect(
        isParentImplementAllWithAutoMergeEligible({
          openChildren: [leaf(2)],
          directChildren: [leaf(2)],
          workItems: [{ githubIssueNumber: 2, state }],
          workItemsLoading: false,
        }),
      ).toBe(true)
    }
  })
})

describe("ParentIssueActionsMenu", () => {
  test("renders accessible Actions control for the Parent Issue", () => {
    const html = renderToStaticMarkup(
      <ParentIssueActionsMenu
        parentGithubIssueNumber={42}
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
        parentGithubIssueNumber={7}
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
})
