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
    expect(source).toContain('{ id: "completed", label: "Completed" }')
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

  test("ports the six-column industrial board and responsive lane selector", () => {
    const source = stylesSource()
    expect(source).toContain(".pipeline-board")
    expect(source).toContain("grid-template-columns: repeat(6, minmax(0, 1fr))")
    expect(source).toContain(".lane-header")
    expect(source).toContain("position: sticky")
    expect(source).toContain(".job-ticket")
    expect(source).toContain("@media (max-width: 900px)")
    expect(source).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))")
  })
})
