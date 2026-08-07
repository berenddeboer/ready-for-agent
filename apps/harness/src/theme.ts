/** Theme plumbing for Interchange (`docs/harness-design-system.md` §3). */

export type ThemeMode = "light" | "dark"

const THEME_QUERY_PARAM = "theme"

/** Runs before paint so the first frame matches system / ?theme= pin. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var p=new URLSearchParams(location.search).get(${JSON.stringify(THEME_QUERY_PARAM)});var t=(p==="dark"||p==="light")?p:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`

export function resolveThemeMode(
  search: string,
  prefersDark: boolean,
): ThemeMode {
  const pinned = new URLSearchParams(search).get(THEME_QUERY_PARAM)
  if (pinned === "dark" || pinned === "light") {
    return pinned
  }
  return prefersDark ? "dark" : "light"
}

export function applyThemeMode(theme: ThemeMode): void {
  document.documentElement.setAttribute("data-theme", theme)
}

export function readDocumentTheme(): ThemeMode {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light"
}

/**
 * Root / inherited search shape for the theme pin. Used with
 * `validateSearch` + `retainSearchParams(['theme'])` so SPA navigations
 * keep `?theme=` for bootstrap on reload.
 */
export type ThemeSearch = {
  readonly theme?: ThemeMode
}

/** Parse unknown search (root `validateSearch`) into a typed theme pin. */
export function parseThemeSearch(raw: Record<string, unknown>): ThemeSearch {
  const theme = raw[THEME_QUERY_PARAM]
  if (theme === "dark" || theme === "light") {
    return { theme }
  }
  return {}
}

/**
 * Router `search` updater: set the theme pin while preserving other params.
 * Prefer this over `history.replaceState` so the router stays the source of
 * truth and `retainSearchParams` can keep the pin across Links.
 */
export function withThemePin<T extends Record<string, unknown>>(
  prev: T,
  theme: ThemeMode,
): T & { theme: ThemeMode } {
  return { ...prev, theme }
}

/** Toggle label shows the *target* theme (lever → "Dark" when light). */
export function themeToggleLabel(current: ThemeMode): string {
  return current === "dark" ? "Light" : "Dark"
}

export function oppositeTheme(current: ThemeMode): ThemeMode {
  return current === "dark" ? "light" : "dark"
}
