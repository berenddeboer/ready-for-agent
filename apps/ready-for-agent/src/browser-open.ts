export type BrowserOpenEnv = Partial<
  Record<"NO_BROWSER" | "PORT", string | undefined>
>

export const DEFAULT_UI_PORT = 4200
export const DEFAULT_UI_HOST = "127.0.0.1"

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
