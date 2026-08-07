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

describe("/settings route (issue #840)", () => {
  test("is a dedicated TanStack file route over the Pipeline background", () => {
    const source = settingsSource()
    expect(source).toContain('createFileRoute("/settings")')
    expect(source).toContain("PipelinePage")
    expect(source).toContain('from "./index.js"')
  })

  test("is registered in the generated route tree", () => {
    const source = routeTreeSource()
    expect(source).toContain("from './routes/settings'")
    expect(source).toContain("id: '/settings'")
    expect(source).toContain("path: '/settings'")
    expect(source).toContain("'/settings': typeof SettingsRoute")
  })

  test("explicit openers push /settings with in-app origin state", () => {
    const source = rootSource()
    expect(source).toContain('to: "/settings"')
    expect(source).toContain('kind: "in-app-origin"')
    expect(source).toContain("harnessSettings")
    expect(source).toContain("search: (prev) => prev")
  })

  test("first-run auto-open stays local-only and yields to other routed dialogs", () => {
    const source = rootSource()
    expect(source).toContain("setLocalSettingsOpen(true)")
    expect(source).toContain("isOtherRoutedDialogPath(pathname)")
    // First-run must not navigate to /settings.
    const autoOpenStart = source.indexOf("Automatic first-run")
    expect(autoOpenStart).toBeGreaterThan(-1)
    const autoOpen = source.slice(
      autoOpenStart,
      source.indexOf("const backendChanging"),
    )
    expect(autoOpen).toContain("setLocalSettingsOpen(true)")
    expect(autoOpen).not.toContain('to: "/settings"')
    expect(autoOpen).toContain("isOtherRoutedDialogPath(pathname)")
    // Competing overlays suppress this pass without burning autoOpenAttempted.
    const competing = autoOpen.slice(
      autoOpen.indexOf("isOtherRoutedDialogPath"),
      autoOpen.indexOf("if (routedSettingsOpen)"),
    )
    expect(competing).toContain("return")
    expect(competing).not.toContain("setAutoOpenAttempted(true)")
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
    expect(source).toContain("settingsOpenedFromInAppThisSessionRef")
    expect(source).toContain("settingsOpenedFromInAppThisSessionRef.current &&")
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
    expect(switcher).toContain("isPipelineBackgroundPath")
    const helpers = routedDialogSource()
    expect(helpers).toContain("isHarnessSettingsPath")
    expect(helpers).toContain('pathname === "/settings"')
    expect(helpers).toContain("isOtherRoutedDialogPath")
  })
})
