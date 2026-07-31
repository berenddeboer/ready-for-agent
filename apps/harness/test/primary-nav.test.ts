import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const rootSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8")

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

describe("primary Home / Repos / Completed navigation (Interchange masthead)", () => {
  test("root chrome exposes Home, Repos, and Completed Link controls", () => {
    const source = rootSource()
    expect(source).toContain('aria-label="Primary"')
    expect(source).toContain('to="/"')
    expect(source).toContain('to="/repos"')
    expect(source).toContain('to="/completed"')
    expect(source).toMatch(/Home\s*<\/Link>/)
    expect(source).toMatch(/Repos\s*<\/Link>/)
    expect(source).toMatch(/Completed\s*<\/Link>/)
    expect(source).not.toMatch(/Kanban\s*<\/Link>/)
    expect(source).not.toContain("function KanbanNavIcon()")
    expect(source).not.toContain("<KanbanNavIcon />")
    expect(source).toContain("function HomeNavIcon()")
    expect(source).toContain("<HomeNavIcon />")
    const navBlock = source.slice(
      source.indexOf('aria-label="Primary"'),
      source.indexOf("</nav>"),
    )
    expect(navBlock).not.toContain('to="/kanban"')
  })

  test("masthead band + lane ribbon replace the old primary-nav rule", () => {
    const root = rootSource()
    const styles = stylesSource()
    expect(root).toContain('className="mast"')
    expect(root).toContain('className="lane-ribbon"')
    expect(root).toContain('aria-hidden="true"')
    expect(root).not.toContain("primary-nav")
    expect(styles).toContain(".mast {")
    expect(styles).toContain("background: var(--mast-bg)")
    expect(styles).toContain(".lane-ribbon {")
    expect(styles).toContain("height: 0.4rem")
    expect(styles).not.toContain(".primary-nav {")
    // Ribbon sits above page content (Outlet).
    const chrome = root.slice(root.indexOf("function SettingsChrome("))
    expect(chrome.indexOf("lane-ribbon")).toBeGreaterThan(-1)
    expect(chrome.indexOf("lane-ribbon")).toBeLessThan(
      chrome.indexOf("<Outlet />"),
    )
  })

  test("groups Home, Repos, Completed, Settings, and theme toggle as mast plates", () => {
    const source = rootSource()
    const navBlock = source.slice(
      source.indexOf('aria-label="Primary"'),
      source.indexOf("</nav>"),
    )
    expect(navBlock).toContain('to="/"')
    expect(navBlock).toContain('to="/repos"')
    expect(navBlock).toContain('to="/completed"')
    expect(navBlock).toContain("<HomeNavIcon />")
    expect(navBlock).toContain("<ReposNavIcon />")
    expect(navBlock).toContain("<CompletedNavIcon />")
    expect(navBlock).toContain("<SettingsNavIcon />")
    expect(navBlock).toContain("Settings")
    expect(navBlock).toContain("<ThemeTogglePlate />")
    expect(navBlock).toContain("mastPlateClassName")
    // Order: Home | Repos | Completed | Settings | theme
    const homeIdx = navBlock.indexOf('to="/"')
    const reposIdx = navBlock.indexOf('to="/repos"')
    const completedIdx = navBlock.indexOf('to="/completed"')
    const settingsIdx = navBlock.indexOf("Settings")
    const themeIdx = navBlock.indexOf("<ThemeTogglePlate")
    expect(homeIdx).toBeGreaterThan(-1)
    expect(reposIdx).toBeGreaterThan(homeIdx)
    expect(completedIdx).toBeGreaterThan(reposIdx)
    expect(settingsIdx).toBeGreaterThan(completedIdx)
    expect(themeIdx).toBeGreaterThan(settingsIdx)
    // Brand title stays outside the mast-nav cluster (left side).
    const brandIdx = source.indexOf("Clanker Harness")
    expect(brandIdx).toBeGreaterThan(-1)
    expect(brandIdx).toBeLessThan(source.indexOf('aria-label="Primary"'))
  })

  test("Home, Repos, Completed, and Settings use stroke icons", () => {
    const source = rootSource()
    for (const iconFn of [
      "HomeNavIcon",
      "ReposNavIcon",
      "CompletedNavIcon",
      "SettingsNavIcon",
    ] as const) {
      const start = source.indexOf(`function ${iconFn}(`)
      expect(start).toBeGreaterThan(-1)
      const body = source.slice(start, source.indexOf("\n}", start) + 2)
      expect(body).toContain('aria-hidden="true"')
      expect(body).toContain('stroke="currentColor"')
      expect(body).toContain('strokeWidth="2"')
      expect(body).toContain('fill="none"')
    }
    const homeIcon = source.slice(
      source.indexOf("function HomeNavIcon("),
      source.indexOf("\n}", source.indexOf("function HomeNavIcon(")) + 2,
    )
    expect(homeIcon).toContain("M3 10.5")
    expect(homeIcon).not.toContain("<rect")
  })

  test("uses TanStack Router Link with mast-plate active via aria-current", () => {
    const source = rootSource()
    expect(source).toContain('from "@tanstack/react-router"')
    expect(source).toContain('const mastPlateClassName = "mast-plate"')
    expect(source).toContain('activeProps={{ "aria-current": "page" }}')
    expect(source).toContain("className={mastPlateClassName}")
    // Home nav control must use exact matching.
    const navBlock = source.slice(
      source.indexOf('aria-label="Primary"'),
      source.indexOf("</nav>"),
    )
    const homeSwitcherLink = navBlock.slice(0, navBlock.indexOf('to="/repos"'))
    expect(homeSwitcherLink).toContain('to="/"')
    expect(homeSwitcherLink).toContain("<HomeNavIcon />")
    expect(homeSwitcherLink).toContain("activeOptions={{ exact: true }}")
    // Destinations are client Links, not raw <a href> only.
    expect(source).not.toMatch(/<a\s+href=["']\/repos["']/)
    expect(source).not.toMatch(/<a\s+href=["']\/completed["']/)
    expect(source).not.toMatch(/<a\s+href=["']\/["']/)
    // Active plate styling lives in CSS via aria-current.
    const styles = stylesSource()
    expect(styles).toContain('.mast-plate[aria-current="page"]')
  })

  test("shared nav lives in root chrome so Home, Repos, and Completed inherit it", () => {
    const source = rootSource()
    const chrome = source.slice(source.indexOf("function SettingsChrome("))
    expect(chrome).toContain('to="/repos"')
    expect(chrome).toContain('to="/completed"')
    expect(chrome).toMatch(/Home\s*<\/Link>/)
    expect(chrome).toMatch(/Repos\s*<\/Link>/)
    expect(chrome).toMatch(/Completed\s*<\/Link>/)
    expect(chrome).not.toMatch(/Kanban\s*<\/Link>/)
    expect(chrome).toContain("<Outlet />")
    expect(chrome.indexOf("Home")).toBeLessThan(chrome.indexOf("<Outlet />"))
  })

  test("root shell is always full-width; Repos and Completed cap page body only", () => {
    const root = rootSource()
    const rootComponent = root.slice(root.indexOf("function RootComponent("))
    expect(rootComponent).toContain('className="min-h-screen w-full"')
    expect(rootComponent).not.toContain("useLocation")
    expect(rootComponent).not.toContain("isKanbanPage")
    expect(rootComponent).not.toContain("max-w-[88rem]")
    expect(rootComponent).not.toContain('pathname === "/"')
    // Page content padding is shared; chrome is full-bleed.
    expect(root).toContain('className="page-shell"')
    expect(stylesSource()).toContain(".page-shell {")

    expect(reposSource()).toContain("max-w-[88rem]")
    expect(completedSource()).toContain("max-w-[88rem]")
    expect(reposSource()).toMatch(/className="[^"]*max-w-\[88rem\][^"]*"/)
    expect(completedSource()).toMatch(/className="[^"]*max-w-\[88rem\][^"]*"/)
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
    // Elevated surfaces + inverse CTA ink stay contrast-safe under both themes.
    expect(styles).toContain("--paper-2:")
    expect(styles).toContain("--color-paper-2: var(--paper-2)")
    expect(styles).toContain("--on-solid:")
    expect(styles).toContain("--color-on-solid: var(--on-solid)")
    expect(root).toContain("text-on-solid")
    expect(root).toContain("backdrop:bg-black/50")
    expect(root).not.toContain("backdrop:bg-ink/45")
  })

  test("banner pattern is shared and used for nav-level guidance/alarm", () => {
    const banner = bannerSource()
    const root = rootSource()
    const styles = stylesSource()
    expect(banner).toContain("tone: BannerTone")
    expect(banner).toContain('"alarm"')
    expect(banner).toContain('"guidance"')
    expect(banner).toContain("banner-tag")
    expect(styles).toContain(".banner {")
    expect(styles).toContain(".banner--alarm")
    expect(styles).toContain(".banner--guidance")
    expect(styles).toContain("var(--lane-attention)")
    expect(styles).toContain("var(--signal)")
    expect(root).toContain('tag="Backend"')
    expect(root).toContain('tag="Setup"')
    expect(root).toContain('tone="alarm"')
    expect(root).toContain('tone="guidance"')
    expect(root).toContain("Open Settings")
  })
})
