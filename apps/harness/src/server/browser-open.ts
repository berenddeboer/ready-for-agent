import { spawn } from "node:child_process"

export type BrowserOpenEnv = Partial<
  Record<"NO_BROWSER" | "PORT", string | undefined>
>

const DEFAULT_UI_PORT = 6056
const DEFAULT_UI_HOST = "127.0.0.1"

/** Minimal child surface used by the detached browser launcher (testable). */
export type DetachedBrowserChild = {
  on(event: "error", listener: (error: Error) => void): unknown
  unref(): unknown
}

/** Minimal spawn surface used by the detached browser launcher (testable). */
export type BrowserSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly detached: true
    readonly stdio: "ignore"
  },
) => DetachedBrowserChild

/** Whether production start should open the default browser to the local UI. */
export const shouldOpenBrowser = (input: {
  readonly noOpenFlag: boolean
  readonly env: BrowserOpenEnv
}): boolean => {
  if (input.noOpenFlag) {
    return false
  }

  const raw = input.env.NO_BROWSER?.trim().toLowerCase()
  if (raw === undefined || raw === "") {
    return true
  }

  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return true
  }

  return false
}

export const resolveUiUrl = (
  env: BrowserOpenEnv = {},
  host: string = DEFAULT_UI_HOST,
): string => {
  const port = Number(env.PORT ?? DEFAULT_UI_PORT)
  const safePort =
    Number.isInteger(port) && port >= 1 && port <= 65_535
      ? port
      : DEFAULT_UI_PORT
  return `http://${host}:${safePort}/`
}

export const browserOpenCommand = (
  platform: string,
  url: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } => {
  if (platform === "darwin") {
    return { command: "open", args: [url] }
  }

  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] }
  }

  return { command: "xdg-open", args: [url] }
}

export const hasNoOpenFlag = (
  argv: ReadonlyArray<string> = process.argv,
): boolean => argv.includes("--no-open")

/**
 * Detached best-effort browser launch for standalone production start.
 *
 * Spawn failures (missing `xdg-open`, etc.) arrive on the child `error` event,
 * not as a synchronous throw. Register that handler before `unref()` so the
 * host process cannot terminate from an unhandled spawn error. The GUI process
 * remains detached — shutdown does not own browser lifetime.
 */
export const launchDetachedBrowser = (
  platform: string,
  url: string,
  spawnImpl: BrowserSpawn = spawn as BrowserSpawn,
): void => {
  const { command, args } = browserOpenCommand(platform, url)
  try {
    const child = spawnImpl(command, [...args], {
      detached: true,
      stdio: "ignore",
    })
    // Must attach before unref: unhandled `error` can exit the host (Bun).
    child.on("error", () => {
      // Best-effort only.
    })
    child.unref()
  } catch {
    // Best-effort: startup must not fail when the opener is unavailable.
  }
}
