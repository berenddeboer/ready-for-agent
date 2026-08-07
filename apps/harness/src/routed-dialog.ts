/**
 * Browser-addressable overlay dialog routes (ADR 0048 / issues #840+).
 *
 * Explicit opens push a history entry; automatic first-run Settings stays
 * local-only and must not open when another routed overlay is requested.
 */

/** History state marker for an explicit in-app Harness Settings open. */
export type HarnessSettingsHistoryState = {
  readonly kind: "in-app-origin"
}

/**
 * History state marker for an explicit in-app Session Telemetry open.
 * Optional sessionId is a display hint only — the route key is Work Item ID.
 */
export type SessionTelemetryHistoryState = {
  readonly kind: "in-app-origin"
  readonly sessionId?: string
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

/**
 * Read the optional Session Telemetry origin marker from router/history state.
 */
export const readSessionTelemetryHistoryState = (
  state: unknown,
): SessionTelemetryHistoryState | undefined => {
  if (typeof state !== "object" || state === null) {
    return undefined
  }
  if (!("sessionTelemetry" in state)) {
    return undefined
  }
  const marker = (state as { sessionTelemetry?: unknown }).sessionTelemetry
  if (typeof marker !== "object" || marker === null) {
    return undefined
  }
  if (!("kind" in marker)) {
    return undefined
  }
  if ((marker as { kind: unknown }).kind !== "in-app-origin") {
    return undefined
  }
  const sessionId =
    "sessionId" in marker &&
    typeof (marker as { sessionId: unknown }).sessionId === "string" &&
    (marker as { sessionId: string }).sessionId.length > 0
      ? (marker as { sessionId: string }).sessionId
      : undefined
  return sessionId === undefined
    ? { kind: "in-app-origin" }
    : { kind: "in-app-origin", sessionId }
}

/** True when the pathname is the Harness Settings overlay route. */
export const isHarnessSettingsPath = (pathname: string): boolean =>
  pathname === "/settings" || pathname === "/settings/"

/** Match `/session/<work-item-id>/telemetry` with optional trailing slash. */
const sessionTelemetryPathPattern = /^\/session\/([^/]+)\/telemetry\/?$/

/**
 * Parse Session Telemetry route pathname. Returns the Work Item ID segment or
 * undefined when the path is not a telemetry overlay.
 */
export const parseSessionTelemetryPath = (
  pathname: string,
): { readonly workItemId: string } | undefined => {
  const match = sessionTelemetryPathPattern.exec(pathname)
  if (match === null) {
    return undefined
  }
  const workItemId = match[1]
  if (workItemId === undefined || workItemId.length === 0) {
    return undefined
  }
  return { workItemId }
}

/** True when the pathname is a Session Telemetry overlay route. */
export const isSessionTelemetryPath = (pathname: string): boolean =>
  parseSessionTelemetryPath(pathname) !== undefined

/**
 * Routed overlays other than Harness Settings. First-run auto-open is
 * suppressed while one of these is requested so two modals never compete.
 * Paths match ADR 0048 even before every route is implemented.
 */
export const isOtherRoutedDialogPath = (pathname: string): boolean => {
  if (/^\/repos\/[^/]+\/settings\/?$/.test(pathname)) {
    return true
  }
  if (isSessionTelemetryPath(pathname)) {
    return true
  }
  return false
}

/**
 * Pipeline is the canonical background for `/settings` and Session Telemetry
 * (direct load / refresh). Jobs switcher treats these as Pipeline-active.
 */
export const isPipelineBackgroundPath = (pathname: string): boolean =>
  pathname === "/" ||
  isHarnessSettingsPath(pathname) ||
  isSessionTelemetryPath(pathname)

/**
 * Document-session flag: true only after an explicit in-app Session Telemetry
 * open in this SPA document. Module-level so Pipeline openers and root close
 * share it; full reload clears it so direct/refresh close uses replace → `/`.
 */
let sessionTelemetryOpenedFromInAppThisDocument = false

export const markSessionTelemetryOpenedFromInApp = (): void => {
  sessionTelemetryOpenedFromInAppThisDocument = true
}

export const wasSessionTelemetryOpenedFromInApp = (): boolean =>
  sessionTelemetryOpenedFromInAppThisDocument
