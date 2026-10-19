/**
 * Opens an OpenCode Session in a new tab after a click-minted pairing grant.
 *
 * The blank tab is opened synchronously so the browser treats it as the
 * operator's click. The connect URL sets the OpenCode cookie and lands on
 * `/`; this then navigates that same tab to the Session. Popup blocking is
 * reported instead of navigating the Harness tab away.
 */

export const OPENCODE_SESSION_POPUP_BLOCKED =
  "The browser blocked the OpenCode window. Allow pop-ups for this site, then try again."

export const OPENCODE_SESSION_HANDOFF_CLOSED =
  "The OpenCode window was closed before the Session opened. Try again."

export const OPENCODE_SESSION_HANDOFF_TIMED_OUT =
  "OpenCode did not accept the connection in time. The window was closed. Try again."

export type OpenCodeLaunchWindow = {
  location: { href: string }
  closed: boolean
  close: () => void
  opener: unknown
}

export type OpenCodeSessionLaunchRequest =
  | {
      readonly connectUrl: string
      readonly sessionUrl: string
    }
  | { readonly unavailableReason: string }

const httpOrigin = (value: string): string | null => {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username.length > 0 || url.password.length > 0) return null
    return url.origin
  } catch {
    return null
  }
}

/** Both URLs must be credential-free and on the same OpenCode origin. */
export const isOpenCodeSessionLaunch = (value: {
  readonly connectUrl: string
  readonly sessionUrl: string
}): boolean => {
  const connectOrigin = httpOrigin(value.connectUrl)
  const sessionOrigin = httpOrigin(value.sessionUrl)
  if (connectOrigin === null || connectOrigin !== sessionOrigin) return false
  try {
    const connect = new URL(value.connectUrl)
    const session = new URL(value.sessionUrl)
    if (!connect.pathname.startsWith("/auth/connect/")) return false
    if (!/^\/server\/[^/]+\/session\/[^/]+$/.test(session.pathname))
      return false
    return true
  } catch {
    return false
  }
}

const readHref = (tab: OpenCodeLaunchWindow): string | null => {
  try {
    return tab.location.href
  } catch {
    return null
  }
}

export const launchOpenCodeSessionWindow = async (input: {
  readonly openBlank: () => OpenCodeLaunchWindow | null
  readonly request: () => Promise<OpenCodeSessionLaunchRequest>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly settleMs?: number
  readonly timeoutMs?: number
}): Promise<
  | { readonly kind: "opened" }
  | { readonly kind: "popup-blocked" }
  | { readonly kind: "unavailable"; readonly message: string }
> => {
  const tab = input.openBlank()
  if (tab === null) {
    return { kind: "popup-blocked" }
  }
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = input.now ?? Date.now
  const settleMs = input.settleMs ?? 500
  const timeoutMs = input.timeoutMs ?? 8_000
  let launch: OpenCodeSessionLaunchRequest
  try {
    launch = await input.request()
  } catch {
    tab.close()
    return {
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_TIMED_OUT,
    }
  }
  if ("unavailableReason" in launch) {
    tab.close()
    return { kind: "unavailable", message: launch.unavailableReason }
  }
  if (!isOpenCodeSessionLaunch(launch)) {
    tab.close()
    return {
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_TIMED_OUT,
    }
  }
  try {
    tab.location.href = launch.connectUrl
  } catch {
    tab.close()
    return {
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_TIMED_OUT,
    }
  }
  const started = now()
  let crossOrigin = false
  while (now() - started < timeoutMs) {
    if (tab.closed) {
      return { kind: "unavailable", message: OPENCODE_SESSION_HANDOFF_CLOSED }
    }
    if (readHref(tab) === null) {
      crossOrigin = true
      break
    }
    await sleep(30)
  }
  if (!crossOrigin) {
    tab.close()
    return {
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_TIMED_OUT,
    }
  }
  // The connect response redirects to `/`. Wait until that commit has set
  // the cookie, then open the Session. A second assignment covers a redirect
  // that lands after the first Session navigation.
  await sleep(settleMs)
  if (tab.closed) {
    return { kind: "unavailable", message: OPENCODE_SESSION_HANDOFF_CLOSED }
  }
  try {
    tab.location.href = launch.sessionUrl
  } catch {
    tab.close()
    return {
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_TIMED_OUT,
    }
  }
  await sleep(settleMs)
  if (!tab.closed) {
    try {
      tab.location.href = launch.sessionUrl
      tab.opener = null
    } catch {
      // The first assignment already left the harness origin.
    }
  }
  return { kind: "opened" }
}
