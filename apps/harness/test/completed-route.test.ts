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

const stylesSource = () =>
  readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")

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

  test("marks Completed primary nav active via aria-current on mast plate", () => {
    const source = rootSource()
    const completedLink = source.slice(
      source.indexOf('to="/completed"'),
      source.indexOf("</Link>", source.indexOf('to="/completed"')) + 7,
    )
    expect(completedLink).toContain("mastPlateClassName")
    expect(completedLink).toContain('activeProps={{ "aria-current": "page" }}')
    expect(completedLink).toContain("Completed")
  })

  test("Completed page body keeps the reading-width cap", () => {
    // Issue #686: width cap is on content, not the shared root shell.
    const source = completedSource()
    expect(source).toContain("max-w-[88rem]")
    expect(source).toMatch(/className="[^"]*max-w-\[88rem\][^"]*"/)
    const root = rootSource()
    const rootComponent = root.slice(root.indexOf("function RootComponent("))
    expect(rootComponent).not.toContain("max-w-[88rem]")
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

  test("renders Interchange archive slab: pagehead, nameboard, 06 roundel", () => {
    const source = completedSource()
    expect(source).toContain('className="pagehead"')
    expect(source).toContain('className="kicker-tag"')
    expect(source).toContain("History")
    expect(source).toContain("Completed work items")
    expect(source).toContain('className="lede"')
    expect(source).toContain('className="pagehead-note"')
    expect(source).toContain("Newest first · All repositories")
    expect(source).toContain('className="archive"')
    expect(source).toContain('className="archive-line"')
    expect(source).toContain('className="roundel"')
    expect(source).toContain(">06</")
    expect(source).toContain('className="nameboard"')
    expect(source).toContain("Full archive")
    expect(source).toContain("Complete + abandoned")
    expect(source).toContain('className="nb-count"')
    expect(source).toContain('className="archive-body"')
    expect(source).toContain('className="archive-empty"')
    expect(source).toContain("No completed work items yet")

    const styles = stylesSource()
    expect(styles).toContain(".archive-row--complete")
    expect(styles).toContain(".archive-row--abandoned")
    expect(styles).toContain(".archive-stamp--abandoned")
    expect(styles).toContain(".leg--lane")
    expect(styles).toContain(".leg--fail")
    expect(styles).toContain("--merged-halo")
    expect(styles).toContain(".plate-mini")
  })

  test("reuses CompletedWorkItemRow for historical completed cards", () => {
    const source = completedSource()
    expect(source).toContain("<CompletedWorkItemRow")
    expect(source).toContain('from "../completed-work-item-row.js"')

    const row = rowSource()
    expect(row).toContain("export function CompletedWorkItemRow(")
    expect(row).toContain("workItem.agentBackend.label")
    expect(row).toContain("onOpenSession")
    expect(row).toContain("planArchiveLegs")
    expect(row).toContain("archive-row--complete")
    expect(row).toContain("archive-row--abandoned")
    expect(row).toContain("archive-stamp--abandoned")
    expect(row).toContain("Abandoned")
    expect(row).toContain("No change")
    expect(row).toContain("prbadge")
    expect(row).toContain("workItemIssueUrl")
    expect(row).toContain("workItemPullRequestUrl")
    // Complete is unstamped; board lifecycle chrome stays off this surface.
    expect(row).not.toContain("WorkItemLifecycleStatus")
    expect(row).not.toContain("stateLabel")
  })

  test("exposes accessible previous/next pagination with current page indication", () => {
    const source = completedSource()
    expect(source).toContain('aria-label="Completed work items pagination"')
    expect(source).toContain("← Prev")
    expect(source).toContain("Next →")
    expect(source).toContain('className="plate-mini"')
    expect(source).toContain('className="pager"')
    expect(source).toContain('className="pager-note"')
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
    expect(source).toContain("No completed work items yet")
    expect(source).toContain("No completed work items on this page")
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
