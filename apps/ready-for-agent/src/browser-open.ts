import { spawn } from "node:child_process"

export type BrowserOpenEnv = Partial<
  Record<"NO_BROWSER" | "PORT", string | undefined>
>

const DEFAULT_UI_PORT = 6056
const DEFAULT_UI_HOST = "127.0.0.1"

/** Whether start should open the default browser to the local UI. */
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

/**
 * Detached browser launch is deliberately a host boundary: polling uses fetch
 * and the launcher must outlive its child rather than be scoped to an Effect.
 */
export const openBrowserWhenReady = (platform: string, url: string): void => {
  const { command, args } = browserOpenCommand(platform, url)
  const deadline = Date.now() + 60_000

  const tryOpen = async () => {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { redirect: "manual" })
        void response.body?.cancel()
        if (response.status > 0) {
          spawn(command, [...args], {
            detached: true,
            stdio: "ignore",
          }).unref()
          return
        }
      } catch {
        // Port not ready yet.
      }
      await Bun.sleep(250)
    }
  }

  void tryOpen()
}
