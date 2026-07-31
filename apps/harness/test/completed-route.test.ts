import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const completedSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/completed.tsx"), "utf8")

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const rowSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/completed-work-item-row.tsx"),
    "utf8",
  )

const routeTreeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routeTree.gen.ts"), "utf8")

describe("/completed route", () => {
  test("is a dedicated TanStack file route registered in the route tree", () => {
    const source = completedSource()
    expect(source).toContain('createFileRoute("/completed")')
    expect(source).toContain("function CompletedPage(")
    expect(source).toContain("<CompletedWorkItemsBoard />")

    const tree = routeTreeSource()
    expect(tree).toContain("'/completed'")
    expect(tree).toContain("CompletedRoute")
    expect(tree).toContain("./routes/completed")
  })

  test("marks Completed primary nav active via the shared Link active props", () => {
    const source = rootSource()
    const completedLink = source.slice(
      source.indexOf('to="/completed"'),
      source.indexOf("</Link>", source.indexOf('to="/completed"')) + 7,
    )
    expect(completedLink).toContain("primaryNavLinkClassName")
    expect(completedLink).toContain(
      "activeProps={{ className: primaryNavLinkActiveClassName }}",
    )
    expect(completedLink).toContain(
      "inactiveProps={{ className: primaryNavLinkInactiveClassName }}",
    )
    expect(completedLink).toContain("Completed")
  })

  test("queries the server-paginated completedWorkItems history API", () => {
    const index = indexSource()
    expect(index).toContain("completedWorkItemsHistoryQuery")
    expect(index).toContain("COMPLETED_WORK_ITEMS_PAGE_SIZE")
    expect(index).toContain("completedWorkItems:")
    expect(index).toContain("pageSize: COMPLETED_WORK_ITEMS_PAGE_SIZE")
    // Distinct from per-repo Jobs Completed (24 h listKind).
    expect(index).toContain('listKind: "COMPLETED"')
    expect(index).toContain("jobsCompletedWorkItemsQuery")

    const source = completedSource()
    expect(source).toContain("completedWorkItemsHistoryQuery(page)")
    expect(source).toContain("COMPLETED_WORK_ITEMS_PAGE_SIZE")
  })

  test("reuses CompletedWorkItemRow for historical completed cards", () => {
    const source = completedSource()
    expect(source).toContain("<CompletedWorkItemRow")
    expect(source).toContain('from "../completed-work-item-row.js"')

    const row = rowSource()
    expect(row).toContain("export function CompletedWorkItemRow(")
    expect(row).toContain("workItem.agentBackend.label")
    expect(row).toContain("onOpenSession")
    expect(row).toContain("<WorkItemLifecycleStatus")
    expect(row).toContain("workItemIssueUrl")
    expect(row).toContain("workItemPullRequestUrl")
  })

  test("exposes accessible previous/next pagination with current page indication", () => {
    const source = completedSource()
    expect(source).toContain('aria-label="Completed work items pagination"')
    expect(source).toContain("Previous")
    expect(source).toContain("Next")
    expect(source).toContain(
      'aria-label="Previous page of completed work items"',
    )
    expect(source).toContain('aria-label="Next page of completed work items"')
    expect(source).toContain("disabled={!hasPreviousPage")
    expect(source).toContain("disabled={!hasNextPage")
    expect(source).toContain("Page {currentPage} of {resolvedTotalPages}")
    expect(source).toContain("rangeStart")
    expect(source).toContain("rangeEnd")
    expect(source).toContain('aria-live="polite"')
  })

  test("handles empty archive vs empty page, loading, and error states", () => {
    const source = completedSource()
    expect(source).toContain("No completed work items yet.")
    expect(source).toContain("No completed work items on this page.")
    expect(source).toContain("resolvedTotalCount === 0")
    expect(source).toContain("setPage(totalPages)")
    expect(source).toContain("Loading completed work items")
    expect(source).toContain("Could not load completed work items")
    // Hard error only with no data; soft banner when refresh fails with data.
    expect(source).toContain(
      "completedQuery.isError && completedQuery.data === undefined",
    )
    expect(source).toContain("Showing last loaded page.")
    expect(source).toContain("Math.min(pageData.page, resolvedTotalPages)")
    expect(source).toContain("function CompletedListSkeleton(")
    // Historical query only — does not call Jobs listKind COMPLETED.
    expect(source).not.toContain("jobsCompletedWorkItemsQuery")
    expect(source).not.toContain('listKind: "COMPLETED"')
  })

  test("mounts Work Item live updates for the full board lifetime (not only success UI)", () => {
    const source = completedSource()
    expect(source).toContain('from "../work-items-live-updates.js"')
    expect(source).toContain(
      "const live = <WorkItemsLiveUpdates repositoryIds={repositoryIds} />",
    )
    // Live mount precedes pending/error early returns so abort cleanup cannot
    // cancel the completed-work-items prefix while a page fetch is in flight.
    const liveIdx = source.indexOf(
      "const live = <WorkItemsLiveUpdates repositoryIds={repositoryIds} />",
    )
    const pendingIdx = source.indexOf(
      "completedQuery.isPending && completedQuery.data === undefined",
    )
    const errorIdx = source.indexOf(
      "completedQuery.isError && completedQuery.data === undefined",
    )
    expect(liveIdx).toBeGreaterThan(-1)
    expect(pendingIdx).toBeGreaterThan(liveIdx)
    expect(errorIdx).toBeGreaterThan(liveIdx)
  })

  test("keeps previous page data while the next page loads", () => {
    const index = indexSource()
    expect(index).toContain("placeholderData: keepPreviousData")
    expect(index).toContain("keepPreviousData")
    expect(index).toMatch(
      /completedWorkItemsHistoryQuery[\s\S]*placeholderData: keepPreviousData/,
    )
  })
})
