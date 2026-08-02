import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const boardSource = () =>
  readFileSync(join(import.meta.dir, "../src/kanban-board.tsx"), "utf8")

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const kanbanRedirectSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/kanban.tsx"), "utf8")

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const uiSource = () =>
  readFileSync(join(import.meta.dir, "../src/ui.ts"), "utf8")

const stylesSource = () =>
  readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")

describe("kanban home board", () => {
  test("home route renders the board when repositories exist", () => {
    const home = homeSource()
    expect(home).toContain('createFileRoute("/")')
    expect(home).toContain("function HomeContent()")
    expect(home).toContain("(repositories ?? []).length === 0")
    expect(home).toContain("<EmptyRepositoriesBlankSlate />")
    expect(home).toContain("<KanbanBoard />")
    expect(home).toContain('from "../kanban-board.js"')
    // Membership SSE covers both blank slate and board without `/repos`.
    expect(home).toContain("function HomeRepositoryMembershipLive()")
    expect(home).toContain("followRepositoryMembershipLive")
    expect(home).toContain("liveUpdatesWarningPresentation")
  })

  test("/kanban redirects to home", () => {
    const source = kanbanRedirectSource()
    expect(source).toContain('createFileRoute("/kanban")')
    expect(source).toContain("redirect")
    expect(source).toContain('to: "/"')
    expect(source).toContain("replace: true")
    expect(source).toContain("beforeLoad")
    expect(source).not.toContain("KanbanJobsBoard")
    expect(source).not.toContain("KanbanBoard")
  })

  test("board mounts pipeline body; Jobs switcher lives in sticky root chrome", () => {
    const source = boardSource()
    expect(source).toContain("export function KanbanBoard()")
    // Primary Pipeline | Repos | Completed tabs are sticky root chrome, not the board.
    expect(source).not.toContain('id="jobs-tab-pipeline"')
    expect(source).not.toContain('id="jobs-tab-repos"')
    expect(source).not.toContain('to="/completed"')
    expect(source).not.toContain("<CommittedPullRequestsDashboard />")
    expect(source).toContain("<KanbanJobsBoard />")
    expect(source).toContain('id="jobs-panel-pipeline"')
  })

  test("does not render the former board masthead (title, deck, or separator)", () => {
    // Issue #670: decorative masthead is removed; content starts under primary nav.
    const source = boardSource()
    expect(source).not.toContain("board-masthead")
    expect(source).not.toContain("board-kicker")
    expect(source).not.toContain("board-title")
    expect(source).not.toContain("board-deck")
    expect(source).not.toContain("Autonomous delivery control")
    expect(source).not.toContain("Work pipeline")
    expect(source).not.toContain("Live production flow from intake to merge.")

    // Jobs pipeline is the first content landmark under main (throughput is root chrome).
    const main = source.slice(source.indexOf("<main"))
    const firstSection = main.indexOf("<section")
    expect(firstSection).toBeGreaterThan(-1)
    expect(main.slice(firstSection, firstSection + 80)).toContain(
      'aria-label="Jobs"',
    )
    // Board body is uncapped industrial-shell; throughput chrome is in root.
    expect(source).toContain("className={ui.industrialShell}")
    expect(source).not.toMatch(/industrial-shell pt-6/)
  })

  test("does not render the Jobs section header band (eyebrow, title, LIVE, collapse)", () => {
    // Issue #681: header band is gone; board mounts unconditionally. Tab/source
    // filter chrome stays inside KanbanJobsBoard (see tabs/filtering test).
    const source = boardSource()
    expect(source).not.toContain("section-rail")
    expect(source).not.toContain("section-index")
    expect(source).not.toContain("section-title")
    expect(source).not.toContain("live-marker")
    expect(source).not.toContain("01 / Live floor")
    expect(source).not.toContain("Live floor")
    expect(source).not.toContain("<CardCollapseToggle")
    expect(source).not.toContain("jobsCardCollapseId")
    expect(source).not.toContain("useCardCollapsed")
    expect(source).not.toContain("jobsCollapsed")
    expect(source).not.toContain("kanban-jobs-card-body")
    expect(source).toContain("<KanbanJobsBoard />")
    expect(source).not.toContain("!jobsCollapsed &&")

    // KanbanBoard itself has no title/eyebrow chrome above the board.
    const page = source.slice(
      source.indexOf("export function KanbanBoard("),
      source.indexOf("function PipelineCompleteSummary"),
    )
    expect(page).not.toContain("section-rail")
    expect(page).not.toContain("Pipeline</h2>")
    expect(page).toContain("<KanbanJobsBoard />")

    // Jobs switcher + filters are sticky root chrome; board starts at the grid.
    const board = source.slice(source.indexOf("function KanbanJobsBoard("))
    expect(board).not.toContain("pipelineControls")
    expect(board).not.toContain("pipeline-controls")
    expect(board).toContain("ui.pipelineBoard")
    expect(board).toContain("useJobsRepositoryFilter")
  })

  test("drops obsolete masthead and section-header styles while keeping industrial pipeline chrome", () => {
    const ui = uiSource()
    const styles = stylesSource()
    // Old Ledger chrome must not live in recipes or the tokens file.
    for (const source of [ui, styles]) {
      expect(source).not.toContain(".board-masthead")
      expect(source).not.toContain(".board-kicker")
      expect(source).not.toContain(".board-title")
      expect(source).not.toContain(".board-deck")
      // Issue #681: section-rail header band styles are gone.
      expect(source).not.toContain(".section-rail")
      expect(source).not.toContain(".section-index")
      expect(source).not.toContain(".section-title")
      expect(source).not.toContain(".live-marker")
      expect(source).not.toContain("industrial-pulse")
    }
    // Pipeline board language remains as Tailwind recipes.
    expect(ui).toContain("pipelineBoard:")
    expect(ui).toContain("pipelineControls:")
    expect(ui).toContain("industrialShell:")
  })

  test("renders all six lifecycle lanes as an accessible pipeline", () => {
    const source = boardSource()
    expect(source).toContain('aria-label="Lifecycle pipeline"')
    expect(source).toContain("pipelineLaneFor(workItem)")
    expect(source).toContain("Lane clear")
    // Mobile switcher + route roundel aria-label + lane header each use {lane.label}.
    expect(source.match(/\{lane\.label\}/g)).toHaveLength(3)
    expect(source).toContain("ui.pipelineRoute")
    expect(source).toContain("ui.laneRoundel")
    expect(source).toContain("ui.laneHeader")
    expect(source).toContain("ui.laneTitle")
    expect(source).not.toContain("lane-number")
    expect(source).not.toContain("lane-count")
    expect(source).toContain("ui.queueHint")
    expect(source).toContain("Feed the queue — label issues with")
    expect(source).toContain("ready-for-agent")
    expect(source).toContain("Implement now")
    expect(source).toContain("Implement locally")
    expect(source).toContain("ui.queueHintMenuIllus")
    expect(source).not.toContain("Manage repos →")
    expect(source).not.toContain("work starts at your repos")
  })

  test("Jobs strip + repository filters are sticky root chrome", () => {
    // Working/Failed list tabs are gone. Switcher + filters are root chrome.
    const source = boardSource()
    const root = rootSource()
    expect(source).not.toContain('type JobsTab = "pipeline" | "completed"')
    expect(source).not.toContain("JOBS_TABS")
    expect(source).not.toContain("JOBS_COMPLETED_TAB_LABEL")
    expect(source).not.toContain("JOBS_COMPLETED_EMPTY_MESSAGE")
    expect(source).not.toContain('{ id: "working", label: "Working" }')
    expect(source).not.toContain('{ id: "failed", label: "Failed" }')
    // Board consumes shared filter; does not render the filter strip itself.
    expect(source).toContain("useJobsRepositoryFilter")
    expect(source).not.toContain("All sources")
    expect(root).toContain("<JobsViewSwitcher")
    expect(root).toContain("JobsRepositoryFilterProvider")
    const switcher = readFileSync(
      join(import.meta.dir, "../src/jobs-view-switcher.tsx"),
      "utf8",
    )
    expect(switcher).toContain("ui.jobsSwitcherBand")
    expect(switcher).toContain("Pipeline")
    expect(switcher).toContain("Repos")
    expect(switcher).toContain("Completed")
    expect(switcher).toContain('to="/repos"')
    expect(switcher).toContain('to="/completed"')
    expect(switcher).toContain("<PipelineTabIcon")
    expect(switcher).toContain("<ReposTabIcon")
    expect(switcher).toContain("<CompletedTabIcon")
    expect(switcher).toContain("<JobsRepositoryFilters")
    const filters = readFileSync(
      join(import.meta.dir, "../src/jobs-repository-filter.tsx"),
      "utf8",
    )
    expect(filters).toContain("All sources")
    expect(filters).toContain("ui.repositoryFilters")
  })

  test("retains board controls and excludes repository management on the board", () => {
    const source = boardSource()
    // Section collapse absence is covered by the #681 header-band test above.
    expect(source).toContain("<SessionUsageDialog")
    expect(source).toContain("<WorkItemPauseButton")
    expect(source).toContain("<WorkItemLifecycleStatus")
    expect(source).toContain("<Copy")
    expect(source).not.toContain("RepositoryCards")
    expect(source).not.toContain("AddRepositoryGuidance")
  })

  test("opens Session usage from tickets in every lane while retaining copy", () => {
    const source = boardSource()
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
    const source = boardSource()
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
    // Started and Elapsed are separate lines (not joined with ·).
    expect(summary).not.toContain('{" · "}')
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
    // Merged-lane omits the COMPLETE status tag (lane is the status).
    expect(ticket).toContain("isCompleteLane ? null : (")
    expect(ticket).toContain("ui.jobTicketStatus")
    // Non-Merged lanes keep compact lifecycle status with earlier-lane collapse.
    expect(ticket).toContain("<WorkItemLifecycleStatus")
    expect(ticket).toContain("collapseEarlierLanes")
    const completeBranch = ticket.slice(ticket.indexOf("isCompleteLane ? ("))
    expect(completeBranch).toContain("<PipelineCompleteSummary")
    expect(completeBranch).toContain("<WorkItemLifecycleStatus")
  })

  test("Kanban tickets opt into earlier-lane lifecycle chip collapse", () => {
    // Issue #679: collapse earlier lanes on board tickets; repos reuses it.
    const source = boardSource()
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

    const home = homeSource()
    const completedRow = readFileSync(
      join(import.meta.dir, "../src/completed-work-item-row.tsx"),
      "utf8",
    )
    // Repos issue chrome opts in (same collapse language as Kanban).
    const homeCalls = [
      ...home.matchAll(/<WorkItemLifecycleStatus[\s\S]*?\/>/g),
    ].map((match) => match[0])
    expect(homeCalls.length).toBeGreaterThan(0)
    expect(
      homeCalls.some((call) => call.includes("collapseEarlierLanes")),
    ).toBe(true)
    // Completed archive uses journey legs, not this lifecycle collapse prop.
    expect(completedRow).not.toContain("collapseEarlierLanes")
    // Prop still defaults off on the component signature.
    expect(home).toContain("collapseEarlierLanes = false")
    // Board path opts in once (ticket only).
    expect(source.match(/collapseEarlierLanes/g)).toHaveLength(1)
  })

  test("Merged-lane compact summary is gated by pipelineLaneFor lane id", () => {
    // Completed history uses archive cards on /completed/*; pipeline Merged
    // still uses PipelineCompleteSummary when laneId === "complete".
    const source = boardSource()
    const board = source.slice(source.indexOf("function KanbanJobsBoard("))
    expect(board).toContain("pipelineLaneFor(workItem)")
    expect(board).toContain("<PipelineTicket")
    const ticket = source.slice(
      source.indexOf("function PipelineTicket("),
      source.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain('const isCompleteLane = laneId === "complete"')
    expect(ticket).toContain("<PipelineCompleteSummary")
    // No local completed-tab ticket list on the home board.
    expect(board).not.toContain("laneId={pipelineLaneFor(workItem)}")
  })

  test("shows agent backend and session id on separate runtime lines", () => {
    const source = boardSource()
    const ticket = source.slice(
      source.indexOf("function PipelineTicket("),
      source.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain("{workItem.agentBackend.label}")
    expect(ticket).toContain("ui.jobTicketRuntime")
    // Backend label is its own line; session sits on a following row.
    expect(ticket).toMatch(
      /<p className=\{ui\.jobTicketRuntimeLine\}>\s*\{workItem\.agentBackend\.label\}\s*<\/p>/,
    )
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
    const source = boardSource()
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
    const source = boardSource()
    const board = source.slice(source.indexOf("function KanbanJobsBoard("))
    expect(board).toContain("sortCompletedNewestFirst")
    expect(board).toContain("const pipelineItems = Array.from(")
    expect(board).not.toMatch(/const pipelineItems\s*=\s*sortNewestFirst\s*\(/)
  })

  test("starts live invalidation after the initial board queries settle", () => {
    const source = boardSource()
    const loadingBranch = source.slice(
      source.indexOf("if (loading && pipelineItems.length === 0)"),
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
    const source = boardSource()
    expect(source).toContain('useState<PipelineLaneId>("queue")')
    expect(source).toContain("className={ui.laneSwitcher}")
    expect(source).toContain("aria-pressed={mobileLane === lane.id}")
    expect(source).toMatch(/aria-controls=\{`lane-panel-\$\{lane\.id\}`\}/)
    expect(source).toContain("onClick={() => setMobileLane(lane.id)}")
    expect(source).toContain("data-mobile-active={mobileLane === lane.id}")
    expect(source).toMatch(/id=\{`lane-panel-\$\{lane\.id\}`\}/)
  })

  test("keeps the six-column board and sticky lane headers on desktop", () => {
    const ui = uiSource()
    // Desktop layout lives on recipe strings (no separate media block).
    expect(ui).toContain("pipelineBoard:")
    expect(ui).toContain("pipelineRoute:")
    // Route spine uses before: pseudo utilities.
    expect(ui).toMatch(/pipelineRoute:[\s\S]*?before:/)
    expect(ui).toContain("laneRoundel:")
    expect(ui).toContain("pipelineLanes:")
    expect(ui).toContain("grid-cols-6")
    expect(ui).toContain("gap-0.5")
    expect(ui).toContain("bg-ink")
    expect(ui).toContain("--lane-bed")
    expect(ui).toContain("bg-[var(--lane-bed)]")
    expect(ui).toContain("laneHeader:")
    expect(ui).toContain("min-h-[5.25rem]")
    expect(ui).toContain("sticky")
    expect(ui).toContain("jobTicket:")
    expect(ui).not.toContain("jobTicketMetalLight")
    // All board tickets use parchment --ticket-fill (#f4f1e8), not white/metal.
    expect(ui).toMatch(/jobTicket:\s*cx\([\s\S]*?bg-\[var\(--ticket-fill\)\]/)
    // No longer gated to Merged only.
    expect(ui).not.toContain("data-[lane=complete]:!bg-[var(--ticket-")
    expect(stylesSource()).toContain("--ticket-fill: #f4f1e8")
    expect(stylesSource()).not.toContain("--ticket-merged:")
    // Dark theme must not restyle the board: light tokens re-locked on surface.
    // Tailwind utilities read --color-* (computed at :root), so aliases must
    // be re-set too — --ink alone does not fix bg-ink / text-ink / border-ink.
    expect(boardSource()).toContain("data-kanban-surface")
    expect(stylesSource()).toContain(
      '[data-theme="dark"] [data-kanban-surface]',
    )
    expect(stylesSource()).toMatch(
      /\[data-theme="dark"\] \[data-kanban-surface\][\s\S]*?--ticket-fill: #f4f1e8/,
    )
    expect(stylesSource()).toMatch(
      /\[data-theme="dark"\] \[data-kanban-surface\][\s\S]*?--color-ink: #151515/,
    )
    expect(stylesSource()).toMatch(
      /\[data-theme="dark"\] \[data-kanban-surface\][\s\S]*?--color-panel: #ffffff/,
    )
    expect(stylesSource()).toMatch(
      /\[data-theme="dark"\] \[data-kanban-surface\][\s\S]*?--color-merged-halo: transparent/,
    )
    expect(ui).toContain("shadow-[inset_6px_0_0")
    expect(ui).toContain("laneSwitcher:")
    // Lane switcher hidden on desktop, grid on mobile.
    expect(ui).toMatch(/laneSwitcher:[\s\S]*?hidden/)
    expect(ui).toContain("queueHint:")
    expect(ui).toContain("queueHintMenuIllus:")
    expect(ui).toContain("queueHintMenuItem:")
    expect(ui).not.toContain("queueHintLink:")
    // Counts live in route roundels; header keeps title only.
    expect(ui).not.toContain("laneNumber:")
    expect(ui).not.toContain("laneCount:")
    // Open white platforms / chrome stack are gone; route line stays.
    expect(ui).not.toContain("laneChrome:")
    expect(ui).not.toContain("lanePlatform:")
    expect(stylesSource()).not.toContain(".lane-chrome")
    expect(stylesSource()).not.toContain(".lane-platform")
  })

  test("uses full viewport chrome on every route; home board stays uncapped under header", () => {
    // Issue #686: root shell never takes max-w-[88rem]; Repos/Completed cap body.
    const root = rootSource()
    const rootComponent = root.slice(root.indexOf("function RootComponent("))
    expect(rootComponent).not.toContain("useLocation")
    expect(rootComponent).not.toContain("isKanbanPage")
    // Interchange chrome is full-bleed; page content uses shared page-shell padding.
    expect(rootComponent).toContain('className="min-h-screen w-full"')
    expect(root).toContain("className={ui.pageShell}")
    // Shell must not pathname-gate or hardcode the reading-width cap.
    expect(rootComponent).not.toContain("max-w-[88rem]")
    expect(rootComponent).not.toContain('pathname === "/"')

    // industrial-shell must not re-impose a second width cap under home board.
    const ui = uiSource()
    const shellMatch = ui.match(/industrialShell:\s*"([^"]*)"/)
    expect(shellMatch).not.toBeNull()
    expect(shellMatch![1]).toBe("mx-auto")
    expect(shellMatch![1]).not.toMatch(/max-w/)
  })

  test("uses a touch-scrollable repository row and three-column lane selector on mobile", () => {
    // Mobile rules are baked into ui recipes as max-[900px]:… utilities.
    const ui = uiSource()
    expect(ui).toContain("repositoryFilters:")
    expect(ui).toMatch(/repositoryFilters:[\s\S]*?max-\[900px\]:flex-nowrap/)
    expect(ui).toMatch(
      /repositoryFilters:[\s\S]*?max-\[900px\]:overflow-x-auto/,
    )
    expect(ui).toMatch(
      /repositoryFilters:[\s\S]*?max-\[900px\]:\[touch-action:pan-x\]/,
    )
    expect(ui).toContain("laneSwitcher:")
    expect(ui).toMatch(/laneSwitcher:[\s\S]*?max-\[900px\]:grid/)
    expect(ui).toMatch(/laneSwitcher:[\s\S]*?max-\[900px\]:grid-cols-3/)
    expect(ui).toContain("pipelineLane:")
    // Hidden by default on mobile; shown when data-mobile-active.
    expect(ui).toMatch(/pipelineLane:[\s\S]*?max-\[900px\]:hidden/)
    expect(ui).toMatch(
      /pipelineLane:[\s\S]*?max-\[900px\]:data-\[mobile-active=true\]:flex/,
    )
    expect(ui).toContain("laneHeader:")
    expect(ui).toMatch(/laneHeader:[\s\S]*?max-\[900px\]:static/)
  })
})
