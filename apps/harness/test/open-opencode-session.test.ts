import {
  OPENCODE_SESSION_HANDOFF_TIMED_OUT,
  OPENCODE_SESSION_POPUP_BLOCKED,
  type OpenCodeLaunchWindow,
  launchOpenCodeSessionWindow,
} from "../src/open-opencode-session.js"
import { describe, expect, it } from "bun:test"

const CONNECT = "http://127.0.0.1:49374/auth/connect/Ejv80WeudfkqaqHV2ZupcQ"
const SESSION =
  "http://127.0.0.1:49374/server/aHR0cDovLzEyNy4wLjAuMTo0OTM3NA/session/ses_ead6dfcf7ffejTs5Mqlo1UD64v"

const fakeWindow = (): OpenCodeLaunchWindow & { hrefs: string[] } => {
  const hrefs: string[] = ["about:blank"]
  let closed = false
  const tab = {
    hrefs,
    closed: false,
    opener: { harness: true } as unknown,
    location: {
      get href() {
        const current = hrefs[hrefs.length - 1] ?? "about:blank"
        if (current.startsWith("http://127.0.0.1:49374")) {
          throw new Error("cross-origin")
        }
        return current
      },
      set href(value: string) {
        hrefs.push(value)
      },
    },
    close: () => {
      closed = true
      tab.closed = true
    },
  }
  void closed
  return tab
}

describe("launchOpenCodeSessionWindow", () => {
  it("opens a blank tab, then the connect URL, then the session URL", async () => {
    const tab = fakeWindow()
    const result = await launchOpenCodeSessionWindow({
      openBlank: () => tab,
      request: async () => ({ connectUrl: CONNECT, sessionUrl: SESSION }),
      sleep: async () => undefined,
      settleMs: 0,
      now: () => 0,
    })
    expect(result).toEqual({ kind: "opened" })
    expect(tab.hrefs[0]).toBe("about:blank")
    expect(tab.hrefs[1]).toBe(CONNECT)
    expect(tab.hrefs.at(-1)).toBe(SESSION)
    expect(tab.opener).toBeNull()
    expect(tab.hrefs.join(" ")).not.toContain("password")
  })

  it("reports popup blocking without requesting a grant", async () => {
    let requested = false
    const result = await launchOpenCodeSessionWindow({
      openBlank: () => null,
      request: async () => {
        requested = true
        return { connectUrl: CONNECT, sessionUrl: SESSION }
      },
    })
    expect(result).toEqual({ kind: "popup-blocked" })
    expect(OPENCODE_SESSION_POPUP_BLOCKED.length).toBeGreaterThan(0)
    expect(requested).toBe(false)
  })

  it("closes the blank tab when the server cannot hand off", async () => {
    const tab = fakeWindow()
    const result = await launchOpenCodeSessionWindow({
      openBlank: () => tab,
      request: async () => ({
        unavailableReason: "The harness-owned OpenCode server is unavailable.",
      }),
    })
    expect(result).toEqual({
      kind: "unavailable",
      message: "The harness-owned OpenCode server is unavailable.",
    })
    expect(tab.closed).toBe(true)
    expect(tab.hrefs).toEqual(["about:blank"])
  })

  it("does not navigate to a credentialed or cross-server URL", async () => {
    const tab = fakeWindow()
    const result = await launchOpenCodeSessionWindow({
      openBlank: () => tab,
      request: async () => ({
        connectUrl:
          "http://opencode:secret@127.0.0.1:1/auth/connect/Ejv80WeudfkqaqHV2ZupcQ",
        sessionUrl: SESSION,
      }),
    })
    expect(result.kind).toBe("unavailable")
    expect(tab.closed).toBe(true)
    expect(tab.hrefs).toEqual(["about:blank"])
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  it("closes the tab when the connect navigation never leaves the harness origin", async () => {
    const hrefs = ["about:blank"]
    const tab: OpenCodeLaunchWindow = {
      closed: false,
      opener: {},
      location: {
        get href() {
          return hrefs[hrefs.length - 1] ?? "about:blank"
        },
        set href(value: string) {
          hrefs.push(value)
        },
      },
      close: () => {
        tab.closed = true
      },
    }
    let clock = 0
    const result = await launchOpenCodeSessionWindow({
      openBlank: () => tab,
      request: async () => ({ connectUrl: CONNECT, sessionUrl: SESSION }),
      sleep: async () => {
        clock += 1_000
      },
      now: () => clock,
      timeoutMs: 1_500,
      settleMs: 0,
    })
    expect(result).toEqual({
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_TIMED_OUT,
    })
    expect(tab.closed).toBe(true)
    expect(hrefs.at(-1)).toBe(CONNECT)
    expect(hrefs).not.toContain(SESSION)
  })
})
