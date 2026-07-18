import {
  browserOpenCommand,
  hasNoOpenFlag,
  resolveUiUrl,
  shouldOpenBrowser,
} from "../src/server/browser-open.ts"
import { describe, expect, test } from "bun:test"

describe("production browser open policy", () => {
  test("opens by default", () => {
    expect(shouldOpenBrowser({ noOpenFlag: false, env: {} })).toBe(true)
  })

  test("--no-open disables browser open", () => {
    expect(shouldOpenBrowser({ noOpenFlag: true, env: {} })).toBe(false)
    expect(hasNoOpenFlag(["node", "server.ts", "--no-open"])).toBe(true)
  })

  test("NO_BROWSER disables browser open", () => {
    expect(
      shouldOpenBrowser({ noOpenFlag: false, env: { NO_BROWSER: "1" } }),
    ).toBe(false)
  })

  test("UI URL uses PORT or default 4200", () => {
    expect(resolveUiUrl({})).toBe("http://127.0.0.1:4200/")
    expect(resolveUiUrl({ PORT: "4300" })).toBe("http://127.0.0.1:4300/")
  })

  test("browser open command is platform-appropriate", () => {
    expect(browserOpenCommand("linux", "http://127.0.0.1:4200/")).toEqual({
      command: "xdg-open",
      args: ["http://127.0.0.1:4200/"],
    })
  })
})
