import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MetalLaneHeader } from "../src/metal-lane-header.js"
import { describe, expect, test } from "bun:test"

const boardSource = () =>
  readFileSync(join(import.meta.dir, "../src/kanban-board.tsx"), "utf8")

const metalLaneHeaderSource = () =>
  readFileSync(join(import.meta.dir, "../src/metal-lane-header.tsx"), "utf8")

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

const pipelinePageSource = () =>
  readFileSync(join(import.meta.dir, "../src/pipeline-page.tsx"), "utf8")

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
    const route = homeSource()
    const pipeline = pipelinePageSource()
    expect(route).toContain('createFileRoute("/")')
    expect(route).toContain('from "../pipeline-page.js"')
    expect(pipeline).toContain("function HomeContent()")
    expect(pipeline).toContain("(repositories ?? []).length === 0")
    expect(pipeline).toContain("<EmptyRepositoriesBlankSlate />")
    expect(pipeline).toContain("<KanbanBoard />")
    expect(pipeline).toContain('from "./kanban-board.js"')
    // Membership SSE covers both blank slate and board without `/repos`.
    expect(pipeline).toContain("function HomeRepositoryMembershipLive()")
    expect(pipeline).toContain("followRepositoryMembershipLive")
    expect(pipeline).toContain("liveUpdatesWarningPresentation")
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
    const route = readFileSync(
      join(import.meta.dir, "../src/pipeline-route.tsx"),
      "utf8",
    )
    const metalHeader = metalLaneHeaderSource()
    expect(source).toContain('aria-label="Lifecycle pipeline"')
    // Membership comes from server projection, not client classification.
    expect(source).toContain("kanbanStatusQuery")
    expect(source).not.toContain("pipelineLaneFor")
    expect(source).toContain("Lane clear")
    // Mobile switcher + metal header use {lane.label}; route furnaces live in
    // PipelineRoute (also {lane.label} in accessible names).
    expect(source.match(/\{lane\.label\}/g)).toHaveLength(2)
    expect(source).toContain("<PipelineRoute")
    expect(source).toContain('from "./pipeline-route.js"')
    expect(route).toContain("ui.pipelineRoute")
    expect(route).toContain("ui.laneRoundel")
    expect(route).toContain("ui.laneFurnaceStack")
    expect(route).toContain("ui.laneFurnaceMouth")
    expect(route).toContain("ui.laneFurnaceSmokePuff")
    expect(route).toContain("laneItemsAssignmentKey")
    expect(route).toContain("ROUTE_FED_MS")
    expect(route).toContain("smokeDurationMs")
    expect(route).toContain("furnaceFireLit")
    expect(route).toContain("useLingeringSmoke")
    expect(route).toMatch(/jobs in \$\{lane\.label\}/)
    expect(route).toContain("prefers-reduced-motion")
    // Attention stays cold even when occupied.
    expect(route).toContain("furnaceFireLit(lane.id, count)")
    expect(source).toContain("<MetalLaneHeader")
    expect(metalHeader).toContain("ui.laneHeader")
    expect(metalHeader).toContain("ui.laneTitle")
    expect(source).not.toContain("lane-number")
    expect(source).not.toContain("lane-count")
    expect(source).toContain("ui.queueHint")
    expect(source).toContain("Feed the queue — label issues with")
    expect(source).toContain("ready-for-agent")
    expect(source).toContain("ui.queueHintMenuIllus")
    expect(source).toContain("ui.queueHintImplementBtn")
    expect(source).toContain("ui.queueHintImplementIcon")
    expect(source).toContain("click Implement.")
    expect(source).not.toContain("Implement now")
    expect(source).not.toContain("Implement locally")
    expect(source).not.toContain("ui.queueHintMenuKebab")
    // Issue #742: no redundant Queue tag; blue Implement control teaches
    // the repos path; "your repos" links to the Repos view.
    expect(source).not.toContain("ui.queueHintTag")
    expect(source).not.toContain("ui.queueHintAction")
    expect(source).not.toContain("<strong")
    expect(source).toContain('to="/repos"')
    expect(source).toContain("ui.queueHintLink")
    expect(source).toContain("your repos")
    expect(source).not.toContain("Manage repos →")
    expect(source).not.toContain("work starts at your repos")
  })

  test("mounts lane names on riveted metal sheets", () => {
    const source = metalLaneHeaderSource()
    const ui = uiSource()
    const html = renderToStaticMarkup(
      createElement(MetalLaneHeader, {
        laneId: "attention",
        label: "Attention",
        titleId: "lane-attention",
        ordinal: 5,
      }),
    )
    expect(html).toContain('data-lane="attention"')
    expect(html).toContain('id="lane-attention"')
    expect(html).toContain(">Attention</h3>")
    expect(html).toContain("RFA / 05")
    expect(html.match(/h-\[10px\]/g)).toHaveLength(4)
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(7)
    expect(source).toContain("RIVET_POSITION_CLASSES")
    expect(source).toContain("ui.laneHeaderSheet")
    expect(source).toContain("ui.laneHeaderRivet")
    expect(ui).toContain("laneHeaderSheet:")
    expect(ui).toContain("laneHeaderSurface:")
    expect(ui).toContain("laneHeaderInnerEdge:")
    expect(ui).toContain("laneHeaderDent:")
    expect(ui).toContain("laneHeaderRivet:")
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
    // Session Telemetry is route-driven from root (issue #841); board opens it.
    expect(source).toContain("openSessionTelemetry")
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

  test("Needs Human + PR promotes PR control to top status row (issue #764)", () => {
    // Drop duplicate top NEEDS HUMAN stateLabel; one PR control up top, one
    // Needs Human badge in outcome chrome (showPullRequestBadge false).
    const source = boardSource()
    const ticket = source.slice(
      source.indexOf("function PipelineTicket("),
      source.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain("kanbanPullRequestBadgePlacement")
    expect(ticket).toContain('prBadgePlacement === "header"')
    expect(ticket).toContain("promotePrToHeader")
    // Header PR reuses shared badge recipe + accessible open-in-new-tab name.
    expect(ticket).toContain("prBadgeClassName")
    // Escaped so the assertion matches source template text without Biome
    // noTemplateCurlyInString on a plain string literal.
    expect(ticket).toContain(`Open pull request #\${prNumber}`)
    expect(ticket).toContain("PR #{prNumber} ↗")
    expect(ticket).toContain('target="_blank"')
    // Outcome row omits the second PR badge when the control was promoted.
    expect(ticket).toContain("showPullRequestBadge={!promotePrToHeader}")
    // Pause stays in the top status row with the promoted PR (or stateLabel).
    expect(ticket).toContain("ui.jobTicketStatus")
    expect(ticket).toContain("<WorkItemPauseButton workItem={workItem} />")
    // Non-promoted tickets still render stateLabel in that row.
    expect(ticket).toContain("{workItem.stateLabel}")
    // Lifecycle still receives pullRequestUrl so Decide PR merge chips link.
    const lifecycleCall = ticket.slice(
      ticket.indexOf("<WorkItemLifecycleStatus"),
      ticket.indexOf("/>", ticket.indexOf("<WorkItemLifecycleStatus")) + 2,
    )
    expect(lifecycleCall).toContain("pullRequestUrl={pullRequestUrl}")
    expect(lifecycleCall).toContain("showPullRequestBadge={!promotePrToHeader}")
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

    const home = readFileSync(
      join(import.meta.dir, "../src/home-page-content.tsx"),
      "utf8",
    )
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

  test("Merged-lane compact summary is gated by server lane id complete", () => {
    // Completed history uses archive cards on /completed/*; pipeline Merged
    // still uses PipelineCompleteSummary when laneId === "complete" (MERGED).
    const source = boardSource()
    const board = source.slice(source.indexOf("function KanbanJobsBoard("))
    expect(board).toContain("kanbanStatusQuery")
    expect(board).not.toContain("pipelineLaneFor")
    expect(board).toContain("<PipelineTicket")
    const ticket = source.slice(
      source.indexOf("function PipelineTicket("),
      source.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain('const isCompleteLane = laneId === "complete"')
    expect(ticket).toContain("<PipelineCompleteSummary")
    // Lane comes from the server projection map, not client reclassification.
    expect(board).toContain("laneId={lane.id}")
  })

  test("shows agent backend and session id on separate runtime lines", () => {
    const source = boardSource()
    const ticket = source.slice(
      source.indexOf("function PipelineTicket("),
      source.indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain("{workItem.agentBackend.label}")
    expect(ticket).toContain("<ExecutionProfileSummary")
    expect(ticket).toContain("workItem.executionProfile")
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

  test("contains long runtime lines and copy controls inside the ticket (issue #733)", () => {
    // Flex/grid min-width defaults let mono session/worktree rows paint past
    // the ticket border (esp. Attention). Structural recipes + shrink chain.
    const ui = uiSource()
    expect(ui).toMatch(/jobTicket:\s*cx\([\s\S]*?grid-cols-\[minmax\(0,1fr\)\]/)
    expect(ui).toMatch(/jobTicketRuntime:\s*"[^"]*min-w-0/)
    expect(ui).toMatch(/jobTicketRuntimeLine:\s*"[^"]*max-w-full/)
    expect(ui).toMatch(/jobTicketStatus:\s*"[^"]*min-w-0/)
    expect(ui).toMatch(/jobTicketState:\s*"[^"]*truncate/)
    expect(ui).toMatch(/laneStack:\s*"[^"]*min-w-0/)
    // Status tags and journey legs truncate long labels within the card.
    expect(ui).toMatch(/statusTag:\s*"[^"]*max-w-full[^"]*min-w-0/)
    expect(ui).toMatch(/leg:\s*"[^"]*max-w-full[^"]*min-w-0/)

    const ticket = boardSource().slice(
      boardSource().indexOf("function PipelineTicket("),
      boardSource().indexOf("function KanbanJobsBoard()"),
    )
    // Session value shrinks; copy control stays shrink-0 and fully clickable.
    expect(ticket).toContain('"min-w-0 flex-1 truncate"')
    expect(ticket).toContain(
      '<Copy value={sessionId} showValue={false} className="shrink-0" />',
    )
    expect(ticket).toContain('"flex min-w-0 max-w-full items-center gap-1"')
    expect(ticket).toContain('className="min-w-0 max-w-full"')
    expect(ticket).toContain("textClassName={ui.jobTicketRuntimeLine}")

    // Lifecycle chips: truncating label + non-shrinking duration + title.
    const home = readFileSync(
      join(import.meta.dir, "../src/home-page-content.tsx"),
      "utf8",
    )
    const lifecycle = home.slice(
      home.indexOf("export function WorkItemLifecycleStatus("),
      home.indexOf("function RepositoryIssuesSkeleton("),
    )
    expect(lifecycle).toContain('className="min-w-0 truncate"')
    expect(lifecycle).toContain('className="ml-1 shrink-0 opacity-90"')
    expect(lifecycle).toContain("title={chipTitle}")
    expect(lifecycle).toContain(
      "min-w-0 max-w-full list-none flex-wrap gap-1 p-0",
    )
  })

  test("consumes server kanbanStatus projection with live invalidation and no polling", () => {
    // Board membership is one server projection; issue/repo queries enrich only.
    const source = boardSource()
    const home = readFileSync(
      join(import.meta.dir, "../src/home-page-content.tsx"),
      "utf8",
    )
    expect(source).toContain("kanbanStatusQuery")
    expect(source).toContain("selectedRepositoryId")
    expect(home).toContain("kanbanStatus:")
    expect(home).toContain("kanbanStatusQueryKeyPrefix")
    // Filter switches must not paint the previous source set under a new key.
    const kanbanQuery = home.slice(
      home.indexOf("export const kanbanStatusQuery"),
      home.indexOf("export type CompletedWorkItemsPage"),
    )
    expect(kanbanQuery).not.toMatch(/placeholderData\s*:/)
    // Client no longer assembles Working/Failed/Completed source windows.
    expect(source).not.toContain("jobsWorkingWorkItemsQuery")
    expect(source).not.toContain("jobsFailedWorkItemsQuery")
    expect(source).not.toContain("jobsCompletedWorkItemsQuery")
    expect(source).not.toContain("JOBS_FAILED_LIMIT")
    expect(source).not.toContain("pipelineLaneFor")
    expect(source).not.toContain("sortNewestFirst")
    expect(source).not.toContain("sortCompletedNewestFirst")
    expect(source).toContain("issuesQuery")
    expect(source).toContain("repositoriesQuery")
    expect(source).toContain("<KanbanLiveUpdates")
    // No Working/Failed tab selection that isolates those query sets for a list.
    expect(source).not.toContain("selectedListTab")
    expect(source).not.toMatch(
      /selectedTab === "working"|selectedTab === "failed"/,
    )
    // Query construction lives in home-page-content; board does not open a client.
    expect(source).not.toContain("queryFn:")
    expect(source).not.toContain("createClient(")
    expect(source).not.toContain("setInterval")
    expect(source).not.toContain("refetchInterval")
  })

  test("defers lane membership and ordering to the server projection", () => {
    // Server GraphQL suite owns window/precedence/order proofs; board only maps.
    const source = boardSource()
    const board = source.slice(source.indexOf("function KanbanJobsBoard("))
    expect(board).toContain("kanbanStatusQuery(selectedRepositoryId)")
    expect(board).toContain("map.set(lane.id, lane.workItems)")
    expect(board).not.toContain("pipelineLaneFor")
    expect(board).not.toContain(".sort(")
    expect(board).not.toContain("slice(0, JOBS_FAILED_LIMIT)")
  })

  test("starts live invalidation after the initial board queries settle", () => {
    const source = boardSource()
    const loadingBranch = source.slice(
      source.indexOf("if (kanbanLoading && kanbanStatus === undefined)"),
      source.indexOf("if (kanbanFailed && kanbanStatus === undefined)"),
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
    // Brass pneumatic tube spine (not a plain ink hairline).
    expect(ui).toContain("pipelineRouteSpine:")
    expect(ui).toContain("pipelineRouteSpineBore:")
    expect(ui).toContain("laneRoundel:")
    // Pot-belly furnace chrome (issue #737).
    expect(ui).toContain("laneFurnaceStack:")
    expect(ui).toContain("laneFurnaceBody:")
    expect(ui).toContain("laneFurnaceBand:")
    expect(ui).toContain("laneFurnaceMouth:")
    expect(ui).toContain("laneFurnaceFire:")
    expect(ui).toContain("laneFurnaceEmber:")
    expect(ui).toContain("laneFurnaceFlame:")
    expect(ui).toContain("laneFurnaceGlow:")
    expect(ui).toContain("laneFurnaceSmokePuff:")
    expect(stylesSource()).toContain("@keyframes furnace-fire-flame")
    expect(stylesSource()).toContain("@keyframes furnace-fire-ember")
    // Queue flames use per-tongue delays (no blanket lockstep override).
    expect(stylesSource()).toContain(
      '.lane-furnace[data-lane="queue"] .lane-furnace-flame[data-i="0"]',
    )
    expect(stylesSource()).not.toContain("--flame-base-delay")
    expect(ui).toContain("routeTraveler:")
    expect(ui).toContain("jobTicketDeparting:")
    // Absorb-handoff destination fade (issue #750): opacity-only keyframe.
    expect(ui).toContain("jobTicketArriving:")
    // Phase durations come from ROUTE_*_MS via inline style, not Tailwind literals.
    expect(ui).toContain("ROUTE_TRANSITION_MS")
    expect(stylesSource()).toContain("@keyframes furnace-eject")
    expect(stylesSource()).toContain("@keyframes furnace-absorb")
    expect(stylesSource()).toContain("@keyframes ticket-arrive")
    // Extract the ticket-arrive block only (nested braces in from/to).
    const ticketArrive = stylesSource().match(
      /@keyframes ticket-arrive\s*\{[\s\S]*?\n\}/,
    )?.[0]
    expect(ticketArrive).toBeDefined()
    expect(ticketArrive).toContain("opacity: 0")
    expect(ticketArrive).toContain("opacity: 1")
    // Opacity only — no transform so the lane stack is undisturbed.
    expect(ticketArrive).not.toContain("transform")
    // Ticket wires arriving marker + absorb-duration opacity animation.
    const ticket = boardSource().slice(
      boardSource().indexOf("function PipelineTicket("),
      boardSource().indexOf("function KanbanJobsBoard()"),
    )
    expect(ticket).toContain('data-arriving={arriving ? "true" : undefined}')
    expect(ticket).toContain("ui.jobTicketArriving")
    expect(ticket).toContain("ticket-arrive")
    expect(ticket).toContain("ROUTE_TRANSITION_MS.absorb")
    // Transparent fade must not leave links focusable/clickable mid-arrival.
    expect(ticket).toContain("departing || arriving ? { inert: true }")
    expect(stylesSource()).toContain("@keyframes furnace-smoke-puff")
    expect(stylesSource()).toContain("@keyframes route-travel")
    // Eject/enter must not rotate (avoids phase-handoff snaps).
    expect(stylesSource()).toMatch(
      /@keyframes route-traveler-eject\s*\{[^}]*scale\(0\.12\)[^}]*\}/s,
    )
    expect(stylesSource()).not.toMatch(
      /@keyframes route-traveler-eject\s*\{[^}]*rotate\(/s,
    )
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
    expect(ui).toContain("queueHintImplementBtn:")
    expect(ui).not.toContain("queueHintMenuPanel:")
    expect(ui).not.toContain("queueHintMenuItem:")
    expect(ui).toContain("queueHintLink:")
    // Issue #742: tag chip and bold action emphasis removed from empty-state.
    expect(ui).not.toContain("queueHintTag:")
    expect(ui).not.toContain("queueHintAction:")
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
