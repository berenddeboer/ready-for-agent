/**
 * Browser-addressable overlay dialog routes (ADR 0048 / issue #840+).
 *
 * Explicit opens push a history entry; automatic first-run Settings stays
 * local-only and must not open when another routed overlay is requested.
 */

/** History state marker for an explicit in-app Harness Settings open. */
export type HarnessSettingsHistoryState = {
  readonly kind: "in-app-origin"
}

/**
 * Read the optional Settings origin marker from router/history state.
 * HistoryState is an open bag at runtime; we validate before trusting it.
 */
export const readHarnessSettingsHistoryState = (
  state: unknown,
): HarnessSettingsHistoryState | undefined => {
  if (typeof state !== "object" || state === null) {
    return undefined
  }
  if (!("harnessSettings" in state)) {
    return undefined
  }
  const marker = (state as { harnessSettings?: unknown }).harnessSettings
  if (typeof marker !== "object" || marker === null) {
    return undefined
  }
  if (!("kind" in marker)) {
    return undefined
  }
  if ((marker as { kind: unknown }).kind === "in-app-origin") {
    return { kind: "in-app-origin" }
  }
  return undefined
}

/** True when the pathname is the Harness Settings overlay route. */
export const isHarnessSettingsPath = (pathname: string): boolean =>
  pathname === "/settings" || pathname === "/settings/"

/**
 * Routed overlays other than Harness Settings. First-run auto-open is
 * suppressed while one of these is requested so two modals never compete.
 * Paths match ADR 0048 even before those routes are implemented.
 */
export const isOtherRoutedDialogPath = (pathname: string): boolean => {
  if (/^\/repos\/[^/]+\/settings\/?$/.test(pathname)) {
    return true
  }
  if (/^\/session\/[^/]+\/telemetry\/?$/.test(pathname)) {
    return true
  }
  return false
}

/** Pipeline is the canonical background for `/settings` (direct load / refresh). */
export const isPipelineBackgroundPath = (pathname: string): boolean =>
  pathname === "/" || isHarnessSettingsPath(pathname)
