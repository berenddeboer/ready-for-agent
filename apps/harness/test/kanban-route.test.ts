import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const kanbanSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/kanban.tsx"), "utf8")

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const stylesSource = () =>
  readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")

describe("/kanban route", () => {
  test("is a dedicated TanStack file route with Pipeline selected by default", () => {
    const source = kanbanSource()
    expect(source).toContain('createFileRoute("/kanban")')
    expect(source).toContain('useState<JobsTab>("pipeline")')
    expect(source).toContain("<CommittedPullRequestsDashboard />")
    expect(source).toContain("<KanbanJobsBoard />")
  })

  test("does not render the former board masthead (title, deck, or separator)", () => {
    // Issue #670: decorative masthead is removed; content starts under primary nav.
    const source = kanbanSource()
    expect(source).not.toContain("board-masthead")
    expect(source).not.toContain("board-kicker")
    expect(source).not.toContain("board-title")
    expect(source).not.toContain("board-deck")
    expect(source).not.toContain("Autonomous delivery control")
    expect(source).not.toContain("Work pipeline")
    expect(source).not.toContain("Live production flow from intake to merge.")

    // Committed PR dashboard is the first content landmark under main.
    const main = source.slice(source.indexOf("<main"))
    const firstSection = main.indexOf("<section")
    expect(firstSection).toBeGreaterThan(-1)
    expect(main.slice(firstSection, firstSection + 80)).toContain(
      'aria-label="Committed pull requests"',
    )
    // Intentional top spacing only — no masthead-sized clamp padding.
    expect(source).toMatch(/industrial-shell pt-6 sm:pt-8/)
  })

  test("drops obsolete masthead styles while keeping industrial pipeline chrome", () => {
    const styles = stylesSource()
    expect(styles).not.toContain(".board-masthead")
    expect(styles).not.toContain(".board-kicker")
    expect(styles).not.toContain(".board-title")
    expect(styles).not.toContain(".board-deck")
    // Pipeline board language remains.
    expect(styles).toContain(".pipeline-board")
    expect(styles).toContain(".industrial-shell")
  })

  test("renders all six lifecycle lanes as an accessible pipeline", () => {
    const source = kanbanSource()
    expect(source).toContain('aria-label="Lifecycle pipeline"')
    expect(source).toContain("pipelineLaneFor(workItem)")
    expect(source).toContain("Lane clear")
    expect(source.match(/\{lane\.label\}/g)).toHaveLength(2)
  })

  test("retains accessible two-tab control, keyboard navigation, and repository filtering", () => {
    // Issue #675: Working and Failed tabs are Home-only; Kanban keeps Pipeline
    // (default) and Completed last 24 h.
    const source = kanbanSource()
    expect(source).toContain('type JobsTab = "pipeline" | "completed"')
    expect(source).toContain('{ id: "pipeline", label: "Pipeline" }')
    expect(source).toContain(
      '{ id: "completed", label: JOBS_COMPLETED_TAB_LABEL }',
    )
    expect(source).toContain(
      "Completed last $" + "{JOBS_COMPLETED_WINDOW_HOURS} h",
    )
    expect(source).not.toContain('{ id: "working", label: "Working" }')
    expect(source).not.toContain('{ id: "failed", label: "Failed" }')
    expect(source).not.toContain('label: "Working"')
    expect(source).not.toContain('label: "Failed"')
    expect(source).not.toContain("No working jobs.")
    expect(source).not.toContain("No failed jobs.")
    expect(source).not.toContain("Working jobs")
    expect(source).not.toContain("Failed jobs")
    expect(source).not.toContain('tab.id === "working"')
    expect(source).not.toContain('tab.id === "failed"')
    expect(source).not.toContain('selectedListTab === "working"')
    expect(source).not.toContain('selectedListTab === "failed"')
    expect(source).toContain("JOBS_COMPLETED_EMPTY_MESSAGE")
    expect(source).toContain(
      "No jobs completed in the last $" + "{JOBS_COMPLETED_WINDOW_HOURS} h.",
    )
    // Tab strip order: Pipeline then Completed only.
    const jobsTabsBlock = source.slice(
      source.indexOf("const JOBS_TABS = ["),
      source.indexOf(
        "] as const satisfies readonly { id: JobsTab; label: string }[]",
      ),
    )
    const pipelineTabIndex = jobsTabsBlock.indexOf('label: "Pipeline"')
    const completedTabIndex = jobsTabsBlock.indexOf(
      "label: JOBS_COMPLETED_TAB_LABEL",
    )
    expect(pipelineTabIndex).toBeGreaterThan(-1)
    expect(completedTabIndex).toBeGreaterThan(pipelineTabIndex)
    expect(jobsTabsBlock).not.toContain("Working")
    expect(jobsTabsBlock).not.toContain("Failed")
    // Keyboard cycles only between the two remaining tabs.
    expect(source).toContain('role="tablist"')
    expect(source).toContain('role="tab"')
    expect(source).toContain("aria-selected={selected}")
    expect(source).toContain('event.key === "ArrowRight"')
    expect(source).toContain('event.key === "ArrowLeft"')
    expect(source).toContain(
      "(tabIndex + delta + JOBS_TABS.length) % JOBS_TABS.length",
    )
    expect(source).toContain("All sources")
    expect(source).toContain("aria-pressed={selectedRepositoryId === null}")
    expect(source).toContain(
      "aria-pressed={selectedRepositoryId === repository.id}",
    )
  })

  test("retains board controls and excludes repository management", () => {
    const source = kanbanSource()
    expect(source).toContain("<CardCollapseToggle")
    expect(source).toContain("<SessionUsageDialog")
    expect(source).toContain("<WorkItemPauseButton")
    expect(source).toContain("<WorkItemLifecycleStatus")
    expect(source).toContain("<Copy")
    expect(source).not.toContain("RepositoryCards")
    expect(source).not.toContain("AddRepositoryGuidance")
  })

  test("opens Session usage from tickets in every lane while retaining copy", () => {
    const source = kanbanSource()
    const ticket = source.slice(
      source.indexOf("function PipelineTicket("),
      source.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain("onOpenSession(workItem.id, sessionId)")
    expect(ticket).toContain("showValue={false}")
    // Merged lane only swaps lifecycle chrome; session/copy remain shared
    // above that branch for every ticket.
    expect(ticket).toContain('laneId === "complete"')
    const sessionIndex = ticket.indexOf("onOpenSession(workItem.id, sessionId)")
    const completeSummaryIndex = ticket.indexOf("<PipelineCompleteSummary")
    expect(sessionIndex).toBeGreaterThan(-1)
    expect(completeSummaryIndex).toBeGreaterThan(sessionIndex)
  })

  test("Merged-lane tickets show start time and total duration without lifecycle steps", () => {
    const source = kanbanSource()
    expect(source).toContain("function PipelineCompleteSummary(")
    const summary = source.slice(
      source.indexOf("function PipelineCompleteSummary("),
      source.indexOf("function PipelineTicket("),
    )
    expect(summary).toContain("formatStartedAgo(workItem.createdAt, nowMs)")
    expect(summary).toContain(
      "totalElapsedMs(workItem.createdAt, workItem.stateReadyAt)",
    )
    expect(summary).toContain("Elapsed ${")
    expect(summary).toContain("formatDuration(elapsedMs)")
    expect(summary).not.toContain("lifecycleLabels")
    expect(summary).not.toContain("WorkItemLifecycleStatus")
    expect(summary).not.toContain("Lifecycle steps")
    // Intentional: no-change completionSummary chrome is out of Merged-lane scope.
    expect(summary).not.toContain("completionSummary")
    expect(summary).not.toContain("WorkItemOutcomePresentation")

    const ticket = source.slice(
      source.indexOf("function PipelineTicket("),
      source.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain('laneId === "complete"')
    expect(ticket).toContain("<PipelineCompleteSummary")
    // Non-Merged lanes keep compact lifecycle status with earlier-lane collapse.
    expect(ticket).toContain("<WorkItemLifecycleStatus")
    expect(ticket).toContain("collapseEarlierLanes")
    const completeBranch = ticket.slice(ticket.indexOf("isCompleteLane ? ("))
    expect(completeBranch).toContain("<PipelineCompleteSummary")
    expect(completeBranch).toContain("<WorkItemLifecycleStatus")
  })

  test("Kanban tickets opt into earlier-lane lifecycle chip collapse", () => {
    // Issue #679: Kanban-only presentation; Home Jobs leaves collapseEarlierLanes off.
    const source = kanbanSource()
    const ticket = source.slice(
      source.indexOf("function PipelineTicket("),
      source.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain("collapseEarlierLanes")
    // Prop is only on the non-Merged WorkItemLifecycleStatus branch.
    const lifecycleCall = ticket.slice(
      ticket.indexOf("<WorkItemLifecycleStatus"),
      ticket.indexOf("/>", ticket.indexOf("<WorkItemLifecycleStatus")) + 2,
    )
    expect(lifecycleCall).toContain("collapseEarlierLanes")
    expect(lifecycleCall).toContain("compact")

    const home = readFileSync(
      join(import.meta.dir, "../src/routes/index.tsx"),
      "utf8",
    )
    const completedRow = readFileSync(
      join(import.meta.dir, "../src/completed-work-item-row.tsx"),
      "utf8",
    )
    // Non-Kanban call sites must not opt into collapse (default remains false).
    const nonKanbanSources = [home, completedRow]
    let nonKanbanCallCount = 0
    for (const nonKanbanSource of nonKanbanSources) {
      const calls = [
        ...nonKanbanSource.matchAll(/<WorkItemLifecycleStatus[\s\S]*?\/>/g),
      ].map((match) => match[0])
      nonKanbanCallCount += calls.length
      for (const call of calls) {
        expect(call).not.toContain("collapseEarlierLanes")
      }
    }
    expect(nonKanbanCallCount).toBeGreaterThan(0)
    // Only the Kanban ticket path opts in; the prop defaults off elsewhere.
    expect(home).toContain("collapseEarlierLanes = false")
    expect(source.match(/collapseEarlierLanes/g)).toHaveLength(1)
  })

  test("Kanban list tabs share Merged-lane compact summary via pipelineLaneFor", () => {
    // Gate is lane identity, not Pipeline vs Completed tab. Completed-tab rows
    // that classify as complete intentionally reuse PipelineCompleteSummary;
    // homepage Jobs Completed isolation is separate (index.tsx JobsCard).
    const source = kanbanSource()
    const board = source.slice(source.indexOf("function KanbanJobsBoard("))
    expect(board).toContain("laneId={pipelineLaneFor(workItem)}")
    expect(board).toContain("<PipelineTicket")
    const ticket = source.slice(
      source.indexOf("function PipelineTicket("),
      source.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain('const isCompleteLane = laneId === "complete"')
    expect(ticket).toContain("<PipelineCompleteSummary")
  })

  test("shows agent backend label inline before session id on pipeline tickets", () => {
    const source = kanbanSource()
    const ticket = source.slice(
      source.indexOf("function PipelineTicket("),
      source.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain("{workItem.agentBackend.label}")
    expect(ticket).toContain('className="job-ticket-runtime"')
    // Runtime row is unconditional so the label shows before a session exists.
    expect(ticket).not.toContain(
      "(sessionId !== null || worktreePath !== null) && (",
    )
    const labelIndex = ticket.indexOf("{workItem.agentBackend.label}")
    const sessionButtonIndex = ticket.indexOf(
      "onOpenSession(workItem.id, sessionId)",
    )
    expect(labelIndex).toBeGreaterThan(-1)
    expect(sessionButtonIndex).toBeGreaterThan(labelIndex)
  })

  test("reuses existing queries and live invalidation without polling", () => {
    // Working/Failed list queries still feed the Pipeline board merge; they are
    // not tab panels. Completed tab still uses jobsCompletedWorkItemsQuery.
    const source = kanbanSource()
    expect(source).toContain("jobsWorkingWorkItemsQuery")
    expect(source).toContain("jobsFailedWorkItemsQuery")
    expect(source).toContain("jobsCompletedWorkItemsQuery")
    expect(source).toContain("issuesQuery")
    expect(source).toContain("repositoriesQuery")
    expect(source).toContain("<KanbanLiveUpdates")
    // No Working/Failed tab selection that isolates those query sets for a list.
    expect(source).not.toContain("selectedListTab")
    expect(source).not.toMatch(
      /selectedTab === "working"|selectedTab === "failed"/,
    )
    expect(source).not.toContain("queryFn:")
    expect(source).not.toContain("createClient(")
    expect(source).not.toContain("setInterval")
    expect(source).not.toContain("refetchInterval")
  })

  test("Pipeline preserves Completed stateReadyAt order instead of re-sorting by createdAt", () => {
    const source = kanbanSource()
    const board = source.slice(source.indexOf("function KanbanJobsBoard("))
    expect(board).toContain("sortCompletedNewestFirst")
    expect(board).toContain("const pipelineItems = Array.from(")
    expect(board).not.toMatch(/const pipelineItems\s*=\s*sortNewestFirst\s*\(/)
  })

  test("starts live invalidation after the initial board queries settle", () => {
    const source = kanbanSource()
    const loadingBranch = source.slice(
      source.indexOf("if (loading && activeItems.length === 0)"),
      source.indexOf("if (failed)"),
    )
    expect(loadingBranch).toContain("<JobsCardSkeleton />")
    expect(loadingBranch).not.toContain("<KanbanLiveUpdates")

    const settledBranch = source.slice(
      source.indexOf("return (\n    <article>"),
    )
    expect(settledBranch).toContain("<KanbanLiveUpdates")
  })

  test("renders an accessible mobile lane selector controlling one selected lane", () => {
    const source = kanbanSource()
    expect(source).toContain('useState<PipelineLaneId>("queue")')
    expect(source).toContain('<fieldset className="lane-switcher">')
    expect(source).toContain("aria-pressed={mobileLane === lane.id}")
    expect(source).toMatch(/aria-controls=\{`lane-panel-\$\{lane\.id\}`\}/)
    expect(source).toContain("onClick={() => setMobileLane(lane.id)}")
    expect(source).toContain("data-mobile-active={mobileLane === lane.id}")
    expect(source).toMatch(/id=\{`lane-panel-\$\{lane\.id\}`\}/)
  })

  test("keeps the six-column board and sticky lane headers on desktop", () => {
    const desktopStyles = stylesSource().split("@media (max-width: 900px)")[0]
    expect(desktopStyles).toContain(".pipeline-board")
    expect(desktopStyles).toContain(
      "grid-template-columns: repeat(6, minmax(0, 1fr))",
    )
    expect(desktopStyles).toContain(".lane-header")
    expect(desktopStyles).toContain("position: sticky")
    expect(desktopStyles).toContain(".job-ticket")
    expect(desktopStyles).toContain(".lane-switcher")
    expect(desktopStyles).toContain("display: none")
  })

  test("uses full viewport width only on /kanban while other routes keep 88rem", () => {
    // Root shell is route-aware: drop max-w-[88rem] for Kanban only; gutters stay.
    const root = rootSource()
    const rootComponent = root.slice(root.indexOf("function RootComponent("))
    expect(rootComponent).toContain("useLocation")
    expect(rootComponent).toContain('pathname === "/kanban"')
    // Shared gutters apply on every route (single base string, not duplicated).
    expect(rootComponent).toContain(
      "mx-auto min-h-screen w-full px-5 py-6 sm:px-8 lg:px-12",
    )
    // 88rem remains available for non-Kanban routes, gated by the Kanban check.
    expect(rootComponent).toContain("max-w-[88rem]")
    expect(rootComponent).toMatch(
      /(?:isKanbanPage|pathname === "\/kanban")[\s\S]{0,200}max-w-\[88rem\]|max-w-\[88rem\][\s\S]{0,200}(?:isKanbanPage|pathname === "\/kanban")/,
    )
    // Cap is not a static always-on className on the wrapper.
    expect(rootComponent).not.toMatch(/className="[^"]*max-w-\[88rem\][^"]*"/)

    // industrial-shell must not re-impose a second width cap under Kanban.
    const styles = stylesSource()
    const shellBlock = styles.slice(
      styles.indexOf(".industrial-shell {"),
      styles.indexOf("}", styles.indexOf(".industrial-shell {")) + 1,
    )
    expect(shellBlock).toContain(".industrial-shell {")
    expect(shellBlock).not.toContain("max-width: 100rem")
    expect(shellBlock).not.toMatch(/max-width\s*:/)
  })

  test("uses a touch-scrollable repository row and three-column lane selector on mobile", () => {
    const mobileStyles = stylesSource().split("@media (max-width: 900px)")[1]
    expect(mobileStyles).toBeDefined()
    expect(mobileStyles).toContain(".repository-filters")
    expect(mobileStyles).toContain("flex-wrap: nowrap")
    expect(mobileStyles).toContain("overflow-x: auto")
    expect(mobileStyles).toContain("touch-action: pan-x")
    expect(mobileStyles).toContain(".lane-switcher")
    expect(mobileStyles).toContain("display: grid")
    expect(mobileStyles).toContain(
      "grid-template-columns: repeat(3, minmax(0, 1fr))",
    )
    expect(mobileStyles).toContain(".pipeline-lane")
    expect(mobileStyles).toContain("display: none")
    expect(mobileStyles).toMatch(
      /\.pipeline-lane\[data-mobile-active="true"\]\s*\{\s*display: block;\s*\}/,
    )
    expect(mobileStyles).toContain(".lane-header")
    expect(mobileStyles).toContain("position: static")
  })
})
