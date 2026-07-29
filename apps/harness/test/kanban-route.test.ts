import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const kanbanSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/kanban.tsx"), "utf8")

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

  test("renders all six lifecycle lanes as an accessible pipeline", () => {
    const source = kanbanSource()
    for (const label of [
      "Queue",
      "Build",
      "Review",
      "Ship",
      "Attention",
      "Complete",
    ]) {
      expect(source).toContain(`"${label}"`)
    }
    expect(source).toContain('aria-label="Lifecycle pipeline"')
    expect(source).toContain("pipelineLaneFor(workItem)")
    expect(source).toContain("Lane clear")
  })

  test("retains accessible tabs, keyboard navigation, and repository filtering", () => {
    const source = kanbanSource()
    expect(source).toContain('{ id: "pipeline", label: "Pipeline" }')
    expect(source).toContain('{ id: "working", label: "Working" }')
    expect(source).toContain('{ id: "failed", label: "Failed" }')
    expect(source).toContain(
      '{ id: "completed", label: JOBS_COMPLETED_TAB_LABEL }',
    )
    expect(source).toContain(
      "Completed last $" + "{JOBS_COMPLETED_WINDOW_HOURS} h",
    )
    expect(source).toContain('role="tablist"')
    expect(source).toContain('role="tab"')
    expect(source).toContain("aria-selected={selected}")
    expect(source).toContain('event.key === "ArrowRight"')
    expect(source).toContain('event.key === "ArrowLeft"')
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
    expect(ticket).not.toContain('laneId === "complete"')
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
    const source = kanbanSource()
    expect(source).toContain("jobsWorkingWorkItemsQuery")
    expect(source).toContain("jobsFailedWorkItemsQuery")
    expect(source).toContain("jobsCompletedWorkItemsQuery")
    expect(source).toContain("issuesQuery")
    expect(source).toContain("repositoriesQuery")
    expect(source).toContain("<KanbanLiveUpdates")
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
