import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const telemetryRouteSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/routes/session.$workItemId.telemetry.tsx"),
    "utf8",
  )

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const kanbanSource = () =>
  readFileSync(join(import.meta.dir, "../src/kanban-board.tsx"), "utf8")

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const completedSurfaceSource = () =>
  readFileSync(join(import.meta.dir, "../src/completed-surface.tsx"), "utf8")

const navSource = () =>
  readFileSync(join(import.meta.dir, "../src/session-telemetry-nav.ts"), "utf8")

const dialogSource = () =>
  readFileSync(join(import.meta.dir, "../src/session-usage-dialog.tsx"), "utf8")

const routeTreeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routeTree.gen.ts"), "utf8")

const jobsSwitcherSource = () =>
  readFileSync(join(import.meta.dir, "../src/jobs-view-switcher.tsx"), "utf8")

const routedDialogSource = () =>
  readFileSync(join(import.meta.dir, "../src/routed-dialog.ts"), "utf8")

describe("Session Telemetry route (issues #841 / #843 / #906)", () => {
  test("is a dedicated TanStack file route with a canonical Pipeline background", () => {
    const source = telemetryRouteSource()
    expect(source).toContain(
      'createFileRoute("/session/$workItemId/telemetry")',
    )
    expect(source).toContain("PipelinePage")
    expect(source).toContain('from "../pipeline-page.js"')
    expect(source).not.toContain('from "./index.js"')
  })

  test("is registered in the generated route tree", () => {
    const source = routeTreeSource()
    expect(source).toContain("from './routes/session.$workItemId.telemetry'")
    expect(source).toContain("id: '/session/$workItemId/telemetry'")
    expect(source).toContain("path: '/session/$workItemId/telemetry'")
    expect(source).toContain(
      "'/session/$workItemId/telemetry': typeof SessionWorkItemIdTelemetryRoute",
    )
  })

  test("Pipeline, Repos, and Completed openers push the same telemetry route", () => {
    const kanban = kanbanSource()
    expect(kanban).toContain("openSessionTelemetry")
    expect(kanban).not.toContain("setSessionDialog")
    expect(kanban).not.toContain("<SessionUsageDialog")

    const index = indexSource()
    expect(index).toContain("openSessionTelemetry")
    expect(index).not.toContain("setSessionDialog")
    expect(index).not.toContain("<SessionUsageDialog")

    const completed = completedSurfaceSource()
    expect(completed).toContain("openSessionTelemetry")
    expect(completed).not.toContain("setSessionDialog")
    expect(completed).not.toContain("<SessionUsageDialog")
    expect(completed).not.toContain('from "./session-usage-dialog.js"')

    const nav = navSource()
    expect(nav).toContain('to: "/session/$workItemId/telemetry"')
    expect(nav).toContain("mask:")
    expect(nav).toContain("markSessionTelemetryOpenedFromInApp")
    expect(nav).toContain("sessionTelemetry")
    expect(nav).toContain('kind: "in-app-origin"')
    expect(nav).toContain("search: (prev) => prev")
  })

  test("root owns the route-driven Session Telemetry overlay", () => {
    const source = rootSource()
    expect(source).toContain("SessionTelemetryOverlay")
    expect(source).toContain("maskedLocation")
    expect(source).toContain("parseSessionTelemetryPath")
    expect(source).toContain("wasSessionTelemetryOpenedFromInApp")
    expect(source).toContain("leaveSessionTelemetryRoute")
    expect(source).toContain("router.history.back")
    expect(source).toContain('to: "/"')
    expect(source).toContain("replace: true")
    expect(source).toContain("SessionUsageDialog")
  })

  test("Jobs switcher derives the active background from the runtime route", () => {
    const switcher = jobsSwitcherSource()
    expect(switcher).toContain("jobsViewForPath")
    expect(switcher).not.toContain(
      "Explicit opens from Repos or Completed share",
    )
    const helpers = routedDialogSource()
    expect(helpers).toContain("isSessionTelemetryPath")
    expect(helpers).toContain("parseSessionTelemetryPath")
  })

  test("dialog retains not-found and optional telemetry states", () => {
    const dialog = dialogSource()
    expect(dialog).toContain("Work Item not found.")
    expect(dialog).toContain("does not provide Session Telemetry")
    expect(dialog).toContain("no longer has this Session locally")
    expect(dialog).toContain("Session Telemetry is temporarily")
    expect(dialog).toContain("Loading usage…")
    expect(dialog).toContain("Could not load Session usage")
    expect(dialog).toContain("ui.dialogTable")
  })
})
