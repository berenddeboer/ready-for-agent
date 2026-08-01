import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

const uiSource = () =>
  readFileSync(join(import.meta.dir, "../src/ui.ts"), "utf8")

const stylesSource = () =>
  readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8")

const reposSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/repos.tsx"), "utf8")

const completedSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/completed.tsx"), "utf8")

const themeSource = () =>
  readFileSync(join(import.meta.dir, "../src/theme.ts"), "utf8")

const bannerSource = () =>
  readFileSync(join(import.meta.dir, "../src/banner.tsx"), "utf8")

const switcherSource = () =>
  readFileSync(join(import.meta.dir, "../src/jobs-view-switcher.tsx"), "utf8")

describe("primary navigation (Interchange masthead + Jobs switcher)", () => {
  test("mast has Settings + theme only; Pipeline | Repos | Completed live under Jobs", () => {
    const source = rootSource()
    const switcher = switcherSource()
    expect(source).toContain('aria-label="Primary"')
    expect(source).not.toContain("function HomeNavIcon()")
    expect(source).not.toContain("<HomeNavIcon />")
    expect(source).not.toContain("function ReposNavIcon()")
    expect(source).not.toContain("<ReposNavIcon />")
    expect(source).not.toContain("function KanbanNavIcon()")
    expect(source).not.toContain("function CompletedNavIcon()")
    const navBlock = source.slice(
      source.indexOf('aria-label="Primary"'),
      source.indexOf("</nav>"),
    )
    expect(navBlock).not.toContain('to="/"')
    expect(navBlock).not.toContain('to="/repos"')
    expect(navBlock).not.toContain('to="/kanban"')
    expect(navBlock).not.toContain('to="/completed"')
    expect(navBlock).not.toMatch(/Home\s*<\/Link>/)
    expect(navBlock).not.toMatch(/Repos\s*<\/Link>/)
    expect(navBlock).not.toMatch(/Completed\s*<\/Link>/)
    expect(navBlock).toContain("Settings")
    expect(navBlock).toContain("<ThemeTogglePlate />")
    // Jobs switcher owns the three primary destinations.
    expect(switcher).toContain('to="/"')
    expect(switcher).toContain('to="/repos"')
    expect(switcher).toContain('to="/completed"')
    expect(switcher).toContain("Pipeline")
    expect(switcher).toContain("Repos")
    expect(switcher).toContain("Completed")
    expect(switcher).toContain("<PipelineTabIcon")
    expect(switcher).toContain("<ReposTabIcon")
    expect(switcher).toContain("<CompletedTabIcon")
  })

  test("masthead band + lane ribbon + merged-PR stats replace the old primary-nav rule", () => {
    const root = rootSource()
    const ui = uiSource()
    const styles = stylesSource()
    expect(root).toContain("className={ui.mast}")
    expect(root).toContain("className={ui.laneRibbon}")
    expect(root).toContain("className={ui.appChrome}")
    expect(root).toContain("className={ui.mergedPrStatsBand}")
    expect(root).toContain("<CommittedPullRequestsDashboard />")
    expect(root).toContain("<JobsViewSwitcher")
    expect(root).toContain("JobsRepositoryFilterProvider")
    expect(root).toContain('aria-hidden="true"')
    expect(root).not.toContain("primary-nav")
    expect(ui).toContain("mast:")
    // Theme utility so styles.css `.bg-mast-bg :focus-visible` matches.
    expect(ui).toMatch(/mast:[\s\S]*?bg-mast-bg/)
    expect(ui).toContain("laneRibbon:")
    expect(ui).toMatch(/laneRibbon:[\s\S]*?h-\[0\.4rem\]/)
    expect(ui).toContain("appChrome:")
    expect(ui).toMatch(/appChrome:[\s\S]*?sticky/)
    expect(ui).toContain("mergedPrStatsBand:")
    expect(ui).toContain("jobsSwitcherBand:")
    // Old Ledger chrome gone from recipes and tokens file.
    for (const source of [ui, styles]) {
      expect(source).not.toContain(".completed-scope-tab")
      expect(source).not.toContain(".primary-nav {")
      expect(source).not.toContain("completedScopeTab:")
      expect(source).not.toContain("primaryNav:")
    }
    // Sticky chrome (ribbon + stats + Jobs switcher) sits above page content.
    const chrome = root.slice(root.indexOf("function SettingsChrome("))
    expect(chrome.indexOf("ui.laneRibbon")).toBeGreaterThan(-1)
    expect(chrome.indexOf("ui.mergedPrStatsBand")).toBeGreaterThan(
      chrome.indexOf("ui.laneRibbon"),
    )
    expect(chrome.indexOf("JobsViewSwitcher")).toBeGreaterThan(
      chrome.indexOf("ui.mergedPrStatsBand"),
    )
    expect(chrome.indexOf("JobsViewSwitcher")).toBeLessThan(
      chrome.indexOf("<Outlet />"),
    )
  })

  test("mast plates are Settings and theme only; brand stays left", () => {
    const source = rootSource()
    const navBlock = source.slice(
      source.indexOf('aria-label="Primary"'),
      source.indexOf("</nav>"),
    )
    expect(navBlock).toContain("<SettingsNavIcon />")
    expect(navBlock).toContain("Settings")
    expect(navBlock).toContain("<ThemeTogglePlate />")
    expect(navBlock).toContain("mastPlateClassName")
    // Theme left of Settings (rightmost control stays Settings).
    const settingsIdx = navBlock.indexOf("Settings")
    const themeIdx = navBlock.indexOf("<ThemeTogglePlate")
    expect(themeIdx).toBeGreaterThan(-1)
    expect(settingsIdx).toBeGreaterThan(themeIdx)
    // Brand wordmark + product line stay outside the mast-nav cluster (left side).
    expect(source).toContain("brandWordmarkLink")
    const wordmarkIdx = source.indexOf("Ready for Agent\n")
    expect(wordmarkIdx).toBeGreaterThan(-1)
    expect(wordmarkIdx).toBeLessThan(source.indexOf('aria-label="Primary"'))
    // Wordmark is the h1 link (after brandWordmarkLink), not only the kicker.
    expect(wordmarkIdx).toBeGreaterThan(source.indexOf("brandWordmarkLink"))
    const productLineIdx = source.indexOf("Clanker Harness")
    expect(productLineIdx).toBeGreaterThan(wordmarkIdx)
    expect(productLineIdx).toBeLessThan(source.indexOf('aria-label="Primary"'))
  })

  test("Jobs switcher and Settings use stroke icons", () => {
    const root = rootSource()
    const switcher = switcherSource()
    const settingsStart = root.indexOf("function SettingsNavIcon(")
    expect(settingsStart).toBeGreaterThan(-1)
    const settingsBody = root.slice(
      settingsStart,
      root.indexOf("\n}", settingsStart) + 2,
    )
    expect(settingsBody).toContain('aria-hidden="true"')
    expect(settingsBody).toContain('stroke="currentColor"')
    expect(settingsBody).toContain('strokeWidth="2"')
    expect(settingsBody).toContain('fill="none"')

    for (const iconFn of [
      "PipelineTabIcon",
      "ReposTabIcon",
      "CompletedTabIcon",
    ] as const) {
      const start = switcher.indexOf(`function ${iconFn}(`)
      expect(start).toBeGreaterThan(-1)
      const body = switcher.slice(start, switcher.indexOf("\n}", start) + 2)
      expect(body).toContain('aria-hidden="true"')
      expect(body).toContain('stroke="currentColor"')
      expect(body).toContain('strokeWidth="2"')
      expect(body).toContain('fill="none"')
    }
  })

  test("Jobs switcher order is Pipeline | Repos | Completed with icons", () => {
    const switcher = switcherSource()
    const tabs = switcher.slice(
      switcher.indexOf('aria-label="Jobs"'),
      switcher.indexOf("<JobsRepositoryFilters"),
    )
    const pipelineIdx = tabs.indexOf('to="/"')
    const reposIdx = tabs.indexOf('to="/repos"')
    const completedIdx = tabs.indexOf('to="/completed"')
    expect(pipelineIdx).toBeGreaterThan(-1)
    expect(reposIdx).toBeGreaterThan(pipelineIdx)
    expect(completedIdx).toBeGreaterThan(reposIdx)
    expect(tabs.indexOf("<PipelineTabIcon")).toBeGreaterThan(-1)
    expect(tabs.indexOf("<ReposTabIcon")).toBeGreaterThan(
      tabs.indexOf("<PipelineTabIcon"),
    )
    expect(tabs.indexOf("<CompletedTabIcon")).toBeGreaterThan(
      tabs.indexOf("<ReposTabIcon"),
    )
    // Pipeline exact-match; filters stay after the primary trio.
    expect(tabs).toContain("activeOptions={{ exact: true }}")
    expect(switcher.indexOf("<JobsRepositoryFilters")).toBeGreaterThan(
      switcher.indexOf('id="jobs-tab-completed"'),
    )
    const ui = uiSource()
    expect(ui).toMatch(/pipelineTab:[\s\S]*?\[&_svg\]/)
  })

  test("mast plates keep stamped styling; brand home link is exact", () => {
    const source = rootSource()
    expect(source).toContain('from "@tanstack/react-router"')
    expect(source).toContain("const mastPlateClassName = ui.mastPlate")
    expect(source).toContain("className={mastPlateClassName}")
    // Wordmark still lands on pipeline home with exact matching.
    const brand = source.slice(
      source.indexOf("ui.brandWordmark"),
      source.indexOf('aria-label="Primary"'),
    )
    expect(brand).toContain('to="/"')
    expect(brand).toContain("activeOptions={{ exact: true }}")
    // Destinations are client Links, not raw <a href> only.
    expect(source).not.toMatch(/<a\s+href=["']\/repos["']/)
    expect(source).not.toMatch(/<a\s+href=["']\/["']/)
    // Active plate styling lives on the recipe via aria-current.
    const ui = uiSource()
    expect(ui).toMatch(/mastPlate:[\s\S]*?aria-\[current=page\]/)
  })

  test("shared Jobs switcher lives in root chrome above Outlet", () => {
    const source = rootSource()
    const chrome = source.slice(source.indexOf("function SettingsChrome("))
    expect(chrome).toContain("<JobsViewSwitcher")
    expect(chrome).toContain("<Outlet />")
    expect(chrome.indexOf("JobsViewSwitcher")).toBeLessThan(
      chrome.indexOf("<Outlet />"),
    )
    // Mast no longer carries Home/Repos/Completed route Links.
    const navBlock = chrome.slice(
      chrome.indexOf('aria-label="Primary"'),
      chrome.indexOf("</nav>"),
    )
    expect(navBlock).not.toMatch(/Home\s*<\/Link>/)
    expect(navBlock).not.toMatch(/Repos\s*<\/Link>/)
    expect(navBlock).not.toMatch(/Completed\s*<\/Link>/)
    expect(navBlock).not.toMatch(/Kanban\s*<\/Link>/)
  })

  test("root shell is always full-width; Repos caps page body only", () => {
    const root = rootSource()
    const rootComponent = root.slice(root.indexOf("function RootComponent("))
    expect(rootComponent).toContain('className="min-h-screen w-full"')
    expect(rootComponent).not.toContain("useLocation")
    expect(rootComponent).not.toContain("isKanbanPage")
    expect(rootComponent).not.toContain("max-w-[88rem]")
    expect(rootComponent).not.toContain('pathname === "/"')
    // Page content padding is shared; chrome is full-bleed.
    expect(root).toContain("className={ui.pageShell}")
    expect(uiSource()).toContain("pageShell:")

    expect(reposSource()).toContain("max-w-[88rem]")
    expect(reposSource()).toMatch(/className="[^"]*max-w-\[88rem\][^"]*"/)
    // Completed is a full-width industrial surface (not a reading-width archive).
    expect(completedSource()).not.toContain("max-w-[88rem]")
  })

  test("ships Interchange token layer with light and dark themes", () => {
    const styles = stylesSource()
    expect(styles).toContain("--lane-queue: #ffd21c")
    expect(styles).toContain("--lane-build: #1976d2")
    expect(styles).toContain("--lane-review: #7654b5")
    expect(styles).toContain("--lane-pr: #168b62")
    expect(styles).toContain("--lane-attention: #ff4d1c")
    expect(styles).toContain("--lane-merged: #151515")
    expect(styles).toContain("--font-display:")
    expect(styles).toContain("Inter Tight")
    expect(styles).toContain("JetBrains Mono")
    expect(styles).toContain('[data-theme="light"]')
    expect(styles).toContain('[data-theme="dark"]')
    expect(styles).toContain("--mast-bg:")
    expect(styles).toContain("--plate:")
    expect(styles).toContain("--merged-halo:")
  })

  test("loads Inter Tight and JetBrains Mono from Google Fonts", () => {
    const source = rootSource()
    expect(source).toContain("fonts.googleapis.com")
    expect(source).toContain("Inter+Tight")
    expect(source).toContain("JetBrains+Mono")
    expect(source).toContain("wght@400;500;600;700;800")
    expect(source).toContain("wght@400;700")
  })

  test("theme plumbing: bootstrap script, prefers-color-scheme, ?theme= pin, toggle plate", () => {
    const root = rootSource()
    const theme = themeSource()
    const styles = stylesSource()
    expect(theme).toContain("THEME_BOOTSTRAP_SCRIPT")
    expect(theme).toContain("prefers-color-scheme")
    expect(theme).toContain('THEME_QUERY_PARAM = "theme"')
    expect(theme).toContain("resolveThemeMode")
    expect(theme).toContain("withThemePin")
    expect(theme).toContain("parseThemeSearch")
    expect(theme).not.toContain("function pinThemeInUrl")
    expect(root).toContain("THEME_BOOTSTRAP_SCRIPT")
    expect(root).toContain("dangerouslySetInnerHTML")
    expect(root).toContain("function ThemeTogglePlate()")
    expect(root).toContain("readDocumentTheme()")
    expect(root).toContain("retainSearchParams")
    expect(root).toContain('retainSearchParams(["theme"])')
    expect(root).toContain("validateSearch")
    expect(root).toContain("withThemePin(prev, next)")
    // Theme pin must not re-root navigation at `/` (would leave Repos/Completed).
    expect(root).not.toContain("useNavigate({ from: Route.fullPath })")
    expect(root).toMatch(
      /function ThemeTogglePlate\(\)[\s\S]*?to:\s*["']\.["']/,
    )
    expect(root).toContain("resetScroll: false")
    // SSR-stable initial state — do not read document in useState (hydration).
    expect(root).toMatch(
      /function ThemeTogglePlate\(\)[\s\S]*?useState<ThemeMode>\("light"\)/,
    )
    expect(root).not.toMatch(
      /useState<ThemeMode>\(\(\)\s*=>\s*[\s\S]*?readDocumentTheme/,
    )
    // Mount effect only syncs state — does not re-resolve/re-apply theme.
    expect(root).not.toMatch(
      /function ThemeTogglePlate\(\)[\s\S]*?useEffect\(\(\) => \{[\s\S]*?resolveThemeMode/,
    )
    expect(root).toMatch(/Switch to \$\{targetLabel\} theme/)
    expect(root).toContain("aria-pressed")
    expect(root).toContain("themeToggleLabel")
    expect(root).toContain("suppressHydrationWarning")
    expect(styles).toContain("color-scheme: light")
    expect(styles).toContain("color-scheme: dark")
    // Dialog scrim token (phase 5) — theme-invariant dimming, not ink-derived.
    expect(styles).toContain("--scrim:")
    // Backdrop via custom Tailwind utility (dialog-backdrop on dialogPanel).
    expect(styles).toContain("@utility dialog-backdrop")
    expect(styles).toContain("::backdrop")
    expect(styles).toContain("background: var(--scrim)")
    expect(uiSource()).toMatch(/dialogPanel:[\s\S]*?dialog-backdrop/)
    expect(root).toContain("ui.dialogPanel")
    // Ledger oxblood / elevated paper-2 palette is gone after phase 5 teardown.
    expect(styles).not.toContain("--paper-2:")
    expect(styles).not.toContain("--color-oxblood")
    expect(styles).not.toContain("--font-serif")
  })

  test("banner pattern is shared and used for nav-level guidance/alarm", () => {
    const banner = bannerSource()
    const root = rootSource()
    const ui = uiSource()
    expect(banner).toContain("tone: BannerTone")
    expect(banner).toContain('"alarm"')
    expect(banner).toContain('"guidance"')
    expect(banner).toContain("ui.bannerTag")
    expect(ui).toContain("banner:")
    expect(ui).toContain("bannerAlarm:")
    expect(ui).toContain("bannerGuidance:")
    expect(ui).toContain("bannerTagAlarm:")
    expect(ui).toContain("bannerTagGuidance:")
    expect(ui).toMatch(/bannerTagAlarm:[\s\S]*?bg-lane-attention/)
    expect(ui).toMatch(/bannerTagGuidance:[\s\S]*?bg-signal/)
    expect(root).toContain('tag="Backend"')
    expect(root).toContain('tag="Setup"')
    expect(root).toContain('tone="alarm"')
    expect(root).toContain('tone="guidance"')
    expect(root).toContain("Open Settings")
  })
})
