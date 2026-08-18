import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const settingsSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/settings.tsx"), "utf8")

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const routedDialogSource = () =>
  readFileSync(join(import.meta.dir, "../src/routed-dialog.ts"), "utf8")

const routeTreeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routeTree.gen.ts"), "utf8")

const jobsSwitcherSource = () =>
  readFileSync(join(import.meta.dir, "../src/jobs-view-switcher.tsx"), "utf8")

const navSource = () =>
  readFileSync(join(import.meta.dir, "../src/harness-settings-nav.ts"), "utf8")

describe("/settings route (issues #840 / #1146)", () => {
  test("is a dedicated TanStack file route over the Pipeline background", () => {
    const source = settingsSource()
    expect(source).toContain('createFileRoute("/settings")')
    expect(source).toContain("PipelinePage")
    expect(source).toContain('from "../pipeline-page.js"')
    expect(source).not.toContain('from "./index.js"')
  })

  test("is registered in the generated route tree", () => {
    const source = routeTreeSource()
    expect(source).toContain("from './routes/settings'")
    expect(source).toContain("id: '/settings'")
    expect(source).toContain("path: '/settings'")
    expect(source).toContain("'/settings': typeof SettingsRoute")
  })

  test("explicit openers mask /settings over the current runtime surface", () => {
    const nav = navSource()
    expect(nav).toContain("openHarnessSettings")
    expect(nav).toContain('to: "."')
    expect(nav).toContain("mask:")
    expect(nav).toContain('to: "/settings"')
    expect(nav).toContain("unmaskOnReload: true")
    expect(nav).toContain("markHarnessSettingsOpenedFromInApp")
    expect(nav).toContain("harnessSettings")
    expect(nav).toContain('kind: "in-app-origin"')
    expect(nav).toContain("search: (prev) => prev")
    expect(nav).toContain("resetScroll: false")

    const source = rootSource()
    expect(source).toContain("openHarnessSettings")
    expect(source).not.toContain('to: "/settings"')
    const settingsChrome = source.slice(
      source.indexOf("function SettingsChrome"),
    )
    expect(settingsChrome).toContain("maskedLocation")
  })

  test("automatic open stays local-only and yields to other routed dialogs", () => {
    const source = rootSource()
    expect(source).toContain("setLocalSettingsOpen(true)")
    expect(source).toContain("isOtherRoutedDialogPath(pathname)")
    // Automatic first-run / recovery must not navigate to /settings.
    const autoOpenStart = source.indexOf("Automatic first-run")
    expect(autoOpenStart).toBeGreaterThan(-1)
    const autoOpen = source.slice(
      autoOpenStart,
      source.indexOf("const backendChanging"),
    )
    expect(autoOpen).toContain("setLocalSettingsOpen(true)")
    expect(autoOpen).not.toContain('to: "/settings"')
    expect(autoOpen).toContain("isOtherRoutedDialogPath(pathname)")
    expect(autoOpen).toContain("getHarnessSettingsAutoOpenAction")
    expect(autoOpen).toContain('backendKind === "UNAVAILABLE"')
  })

  test("dismiss leaves the route for in-app origin or replaces to Pipeline", () => {
    const source = rootSource()
    expect(source).toContain("leaveSettingsRoute")
    expect(source).toContain("router.history.back")
    expect(source).toContain("canGoBack()")
    expect(source).toContain('to: "/"')
    expect(source).toContain("replace: true")
    expect(source).toContain("dismissSettings")
    // Reload must not treat restored history state alone as in-app origin.
    expect(source).toContain("wasHarnessSettingsOpenedFromInApp")
    expect(source).toContain("wasHarnessSettingsOpenedFromInApp() &&")
  })

  test("blocks navigation while Save is pending", () => {
    const source = rootSource()
    expect(source).toContain("useBlocker")
    expect(source).toContain("shouldBlockSettingsLeave")
    expect(source).toContain("updateConfigPendingRef")
    expect(source).toContain("disabled: !updateConfig.isPending")
  })

  test("Jobs switcher treats /settings as Pipeline background", () => {
    const switcher = jobsSwitcherSource()
    expect(switcher).toContain("jobsViewForPath")
    const helpers = routedDialogSource()
    expect(helpers).toContain("isHarnessSettingsPath")
    expect(helpers).toContain('pathname === "/settings"')
    expect(helpers).toContain("isOtherRoutedDialogPath")
  })
})
