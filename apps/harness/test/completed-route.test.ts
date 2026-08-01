import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const completedSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/completed.tsx"), "utf8")

const surfaceSource = () =>
  readFileSync(join(import.meta.dir, "../src/completed-surface.tsx"), "utf8")

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const rowSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/completed-work-item-row.tsx"),
    "utf8",
  )

const uiSource = () =>
  readFileSync(join(import.meta.dir, "../src/ui.ts"), "utf8")

const stylesSource = () =>
  readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")

const routeTreeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routeTree.gen.ts"), "utf8")

describe("Completed surface routes", () => {
  test("registers a single /completed leaf route (no last-24h or all scopes)", () => {
    const source = completedSource()
    expect(source).toContain('createFileRoute("/completed")')
    expect(source).toContain("completedWorkItemsHistoryQuery(page)")
    expect(source).not.toContain("<Outlet />")
    expect(source).not.toContain("jobsCompletedWorkItemsQuery")
    expect(source).not.toContain("JOBS_COMPLETED_WINDOW_HOURS")

    const tree = routeTreeSource()
    expect(tree).toContain("'/completed'")
    expect(tree).toContain("./routes/completed")
    expect(tree).not.toContain("last-24h")
    expect(tree).not.toContain("completed.all")
    expect(tree).not.toContain("completed.index")
    expect(tree).not.toContain("'/completed/all'")
    expect(tree).not.toContain("'/completed/last-24h'")
  })

  test("primary mast no longer links to Completed (entry is Jobs switcher tab)", () => {
    const source = rootSource()
    const navBlock = source.slice(
      source.indexOf('aria-label="Primary"'),
      source.indexOf("</nav>"),
    )
    expect(navBlock).not.toContain('to="/completed"')
    expect(navBlock).not.toMatch(/Completed\s*<\/Link>/)
    expect(navBlock).not.toContain("CompletedNavIcon")
    expect(source).not.toContain("function CompletedNavIcon(")
  })

  test("repository filters live in sticky Jobs chrome; no scope sub-tabs", () => {
    const surface = surfaceSource()
    const switcher = readFileSync(
      join(import.meta.dir, "../src/jobs-view-switcher.tsx"),
      "utf8",
    )
    const filters = readFileSync(
      join(import.meta.dir, "../src/jobs-repository-filter.tsx"),
      "utf8",
    )
    const root = rootSource()
    expect(root).toContain("<JobsViewSwitcher")
    expect(root).toContain("JobsRepositoryFilterProvider")
    expect(switcher).toContain('to="/completed"')
    expect(switcher).toContain('to="/"')
    expect(switcher).toContain('to="/repos"')
    expect(switcher).toContain("Pipeline")
    expect(switcher).toContain("Repos")
    expect(switcher).toContain("Completed")
    expect(switcher).toContain("<CompletedTabIcon")
    expect(switcher).toContain("<JobsRepositoryFilters")
    // Filters only render on Pipeline; Repos/Completed hide them.
    expect(switcher).toContain("showRepositoryFilters")
    expect(switcher).toContain("pipelineActive")
    expect(switcher).not.toContain("completed-scope")
    expect(switcher).not.toContain("COMPLETED_LAST_24H_LABEL")
    expect(switcher).not.toContain("COMPLETED_ALL_LABEL")
    expect(switcher).not.toContain("last-24h")
    expect(switcher).not.toContain("/completed/all")
    expect(filters).toContain("All sources")
    expect(filters).toContain("ui.repositoryFilters")
    // Surface is body only; archive has no client page-local filter.
    expect(surface).not.toContain('to="/completed"')
    expect(surface).not.toContain("All sources")
    expect(surface).not.toContain("COMPLETED_LAST_24H_LABEL")
    expect(surface).not.toContain("JOBS_COMPLETED_WINDOW_HOURS")
    expect(completedSource()).not.toContain("useJobsRepositoryFilter")
    expect(completedSource()).not.toContain("filterWorkItemsByRepository")
  })

  test("uses server-paginated completedWorkItems history API", () => {
    const index = indexSource()
    expect(index).toContain("completedWorkItemsHistoryQuery")
    expect(index).toContain("COMPLETED_WORK_ITEMS_PAGE_SIZE")
    expect(index).toContain("completedWorkItems:")
    expect(index).toContain("pageSize: COMPLETED_WORK_ITEMS_PAGE_SIZE")

    const source = completedSource()
    expect(source).toContain("completedWorkItemsHistoryQuery(page)")
    expect(source).toContain("COMPLETED_WORK_ITEMS_PAGE_SIZE")
    expect(source).toContain("<CompletedSurface")
    expect(source).toContain("<CompletedCardGrid")
    // Full page items from server — not page-local client filter.
    expect(source).toContain("pageData.items")
    expect(source).not.toContain("filterWorkItemsByRepository")
    expect(source).not.toContain("jobsCompletedWorkItemsQuery")
  })

  test("renders archive-style cards in a compact grid (legs + PR)", () => {
    const surface = surfaceSource()
    expect(surface).toContain("<CompletedWorkItemRow")
    expect(surface).toContain("className={ui.completedCardGrid}")

    const row = rowSource()
    expect(row).toContain("export function CompletedWorkItemRow(")
    expect(row).toContain("planArchiveLegs")
    expect(row).toContain("ui.archiveRowComplete")
    expect(row).toContain("ui.archiveRowAbandoned")
    expect(row).toContain("ui.legLane")
    expect(row).toContain("ui.archiveLeg")
    expect(row).toContain("ui.legExpandable")
    expect(row).toContain("aria-expanded")
    expect(row).toContain("ui.archiveLegChips")
    expect(row).toContain("lifecycleStepChipClassNameForStatus")
    // Expanded step chips use the same archive size as BUILD/REVIEW/PR.
    expect(row).toMatch(
      /lifecycleStepChipClassNameForStatus[\s\S]*?ui\.archiveLeg/,
    )
    expect(row).toContain("ui.prbadge")
    // PR badge shares archiveLeg size with BUILD / REVIEW / PR legs.
    expect(row).toMatch(/ui\.prbadge[\s\S]*?ui\.archiveLeg/)
    expect(row).toContain("forgeChangeRequestShort")
    expect(row).toContain("forgeChangeRequestNoun")
    // Full session id on the meta line (not the abbreviated formatSessionShort).
    expect(row).toContain("{sessionId}")
    expect(row).not.toContain("formatSessionShort")
    expect(row).not.toContain("WorkItemLifecycleStatus")
    expect(row).not.toContain("stateLabel")

    const ui = uiSource()
    // Hover is PR-green (same as board merged-lane prBadge).
    expect(ui).toMatch(/prbadge:[\s\S]*?hover:bg-lane-pr/)
    expect(ui).toMatch(/prBadge:[\s\S]*?hover:bg-lane-pr/)
    expect(ui).toContain("completedCardGrid:")
    expect(ui).toContain("minmax(min(100%,34rem),1fr)")
    expect(row).toContain("ui.prbadgeTop")
    expect(row).toContain("ui.archiveRowTopEnd")
    // PR badge shares the repo line (top-right); title is a sibling below.
    const topIdx = row.indexOf("ui.archiveRowTop")
    const titleIdx = row.indexOf("ui.archiveTitle")
    const prTopIdx = row.indexOf("ui.prbadgeTop")
    expect(topIdx).toBeGreaterThan(-1)
    expect(prTopIdx).toBeGreaterThan(topIdx)
    expect(titleIdx).toBeGreaterThan(prTopIdx)
    expect(ui).toContain("archiveRowComplete:")
    // Same light-mode brushed metal as repo cards (shared cardMetalLight).
    expect(ui).toMatch(
      /archiveRow:[\s\S]*?cardMetalLight|archiveRow:[\s\S]*?#f0f2f0_0%/,
    )
    expect(ui).toContain("cardMetalLight")
    // Repos-aligned type: card padding, title metrics, issue-num mono, kicker repo.
    expect(ui).toMatch(/archiveRow:[\s\S]*?px-\[1\.1rem\]/)
    expect(ui).toMatch(/archiveTitle:[\s\S]*?text-\[1\.06rem\]/)
    expect(ui).toMatch(/archiveTitle:[\s\S]*?tracking-\[-0\.01em\]/)
    expect(ui).toMatch(/archiveTitleNum:[\s\S]*?text-\[0\.72rem\]/)
    expect(ui).toMatch(/archiveRepo:[\s\S]*?tracking-\[0\.22em\]/)
    expect(ui).toMatch(/archiveMeta:[\s\S]*?normal-case/)
    expect(row).toContain("ui.archiveTitleLink")
    expect(ui).toContain("legLane:")
    // Exact lane fill (not transparent / not metal wash).
    expect(ui).toMatch(/legLane:[\s\S]*?--leg-lane/)
    expect(ui).not.toContain("legLaneMetal")
    // Archive legs are larger than board density (0.56 → 0.85rem).
    expect(ui).toMatch(/archiveLeg:[\s\S]*?text-\[0\.85rem\]/)
    // Expanded SUCCEEDED chips must keep solid ink fill (not transparent).
    expect(ui).toMatch(/legDone:[\s\S]*?!bg-ink/)
    expect(ui).toMatch(/legDone:[\s\S]*?!text-paper/)
    expect(ui).toContain("legFail:")
    expect(ui).toContain("legExpandable:")
    expect(ui).toContain("archiveLegChips:")
    // Old scope-tab chrome must not return in recipes or tokens file.
    for (const source of [ui, stylesSource()]) {
      expect(source).not.toContain(".completed-scope-tab")
      expect(source).not.toContain(".completed-scope-band")
      expect(source).not.toContain("completedScopeTab:")
      expect(source).not.toContain("completedScopeBand:")
    }
  })

  test("exposes accessible previous/next pagination", () => {
    const source = completedSource()
    expect(source).toContain('aria-label="Completed work items pagination"')
    expect(source).toContain("← Prev")
    expect(source).toContain("Next →")
    expect(source).toContain("className={ui.plateMini}")
    expect(source).toContain("className={ui.pager}")
    expect(source).toContain("className={ui.pagerNote}")
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

  test("handles empty, loading, and error states", () => {
    const source = completedSource()
    expect(source).toContain("No completed work items yet")
    expect(source).toContain("No completed work items on this page")
    expect(source).toContain("setPage(totalPages)")
    expect(source).toContain("Could not load completed work items")
    expect(source).toContain(
      "completedQuery.isError && completedQuery.data === undefined",
    )
    expect(source).toContain("Showing last loaded page.")
    expect(source).toContain("Math.min(pageData.page, resolvedTotalPages)")
    expect(source).toContain("WorkItemsLiveUpdates")
  })

  test("mounts Work Item live updates for the full board lifetime", () => {
    const source = completedSource()
    const liveIdx = source.indexOf(
      "const live = <WorkItemsLiveUpdates repositoryIds={repositoryIds} />",
    )
    const pendingIdx = source.indexOf(
      "completedQuery.isPending && completedQuery.data === undefined",
    )
    expect(liveIdx).toBeGreaterThan(-1)
    expect(pendingIdx).toBeGreaterThan(liveIdx)
  })
})
