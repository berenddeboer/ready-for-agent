import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const routeSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/routes/repos.$repositoryId.settings.tsx"),
    "utf8",
  )

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const reposSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/repos.tsx"), "utf8")

const routeTreeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routeTree.gen.ts"), "utf8")

const jobsSwitcherSource = () =>
  readFileSync(join(import.meta.dir, "../src/jobs-view-switcher.tsx"), "utf8")

describe("/repos/$repositoryId/settings route (issue #842)", () => {
  test("is a dedicated TanStack file route nested under the Repos layout", () => {
    const source = routeSource()
    expect(source).toContain('createFileRoute("/repos/$repositoryId/settings")')
    // Dialog is path-driven in RepositoryCards; route component is a placeholder.
    expect(source).toContain("return null")
    const repos = reposSource()
    expect(repos).toContain("function ReposPage")
    expect(repos).toContain("component: ReposPage")
    expect(repos).toContain("<Outlet")
  })

  test("is registered in the generated route tree under /repos", () => {
    const source = routeTreeSource()
    expect(source).toContain("from './routes/repos.$repositoryId.settings'")
    expect(source).toContain("fullPath: '/repos/$repositoryId/settings'")
    expect(source).toContain("path: '/$repositoryId/settings'")
    expect(source).toContain("getParentRoute: () => ReposRoute")
    expect(source).toContain(
      "'/repos/$repositoryId/settings': typeof ReposRepositoryIdSettingsRoute",
    )
  })

  test("explicit openers push /repos/<id>/settings with in-app origin state", () => {
    const source = homeSource()
    expect(source).toContain('to: "/repos/$repositoryId/settings"')
    expect(source).toContain("params: { repositoryId: repository.id }")
    expect(source).toContain('kind: "in-app-origin"')
    expect(source).toContain("repositorySettings")
    expect(source).toContain("search: (prev) => prev")
    expect(source).toContain("markRepositorySettingsOpenedFromInApp")
  })

  test("dialog open is route-driven by stable Repository ID", () => {
    const source = homeSource()
    expect(source).toContain(
      "isRepositorySettingsPathFor(pathname, repository.id)",
    )
    expect(source).toContain("parseRepositorySettingsRepositoryId")
    // Must not use Project Path in the path.
    expect(source).not.toMatch(
      /to:\s*["'`]\/repos\/\$\{repository\.projectPath\}/,
    )
    expect(source).toContain("repository.projectPath")
  })

  test("dismiss leaves the route for in-app origin or replaces to Repos", () => {
    const source = homeSource()
    expect(source).toContain("leaveSettingsRoute")
    expect(source).toContain("router.history.back")
    expect(source).toContain("canGoBack()")
    expect(source).toContain('to: "/repos"')
    expect(source).toContain("replace: true")
    expect(source).toContain("dismissSettings")
    expect(source).toContain("wasRepositorySettingsOpenedFromInAppThisDocument")
  })

  test("optimistic open enables catalogs and dismiss cancels in-flight navigate", () => {
    const source = homeSource()
    // dialogOpen = routed || optimistic so catalog queries enable immediately.
    expect(source).toContain("optimisticSettingsOpen")
    expect(source).toContain(
      "const dialogOpen = settingsOpen || optimisticSettingsOpen",
    )
    expect(source).toContain("enabled: dialogOpen")
    // Cancel/Escape/Save while navigate is pending leaves when the route commits.
    expect(source).toContain("leaveWhenSettingsRouteCommitsRef")
    expect(source).toContain("settingsOpenIntentGenerationRef")
    expect(source).toContain("leaveWhenSettingsRouteCommitsRef.current = true")
    // dismissingRouteRef must only be set when actually closing the dialog
    // (early leave and normal leave after Escape already closed the dialog).
    expect(source).toContain(
      "Only pair dismissingRouteRef with an actual close",
    )
    expect(source).toContain(
      "Only set dismissingRouteRef when we actually close so the flag cannot stick",
    )
  })

  test("blocks navigation while Save is pending", () => {
    const source = homeSource()
    expect(source).toContain("useBlocker")
    expect(source).toContain("shouldBlockRepositorySettingsLeave")
    expect(source).toContain("updateSettingsPendingRef")
    expect(source).toContain(
      "disabled: !updateSettings.isPending || !settingsOpen",
    )
  })

  test("missing Repository renders an accessible in-dialog not-found state", () => {
    const source = homeSource()
    expect(source).toContain("RepositorySettingsNotFoundDialog")
    expect(source).toContain("Repository not found")
    expect(source).toContain('role="alert"')
    expect(source).toContain("repositoryMissing")
  })

  test("Jobs switcher treats repository settings as Repos background", () => {
    const switcher = jobsSwitcherSource()
    expect(switcher).toContain('pathname.startsWith("/repos/")')
  })
})
