import {
  type BrowserSpawn,
  browserOpenCommand,
  hasNoOpenFlag,
  launchDetachedBrowser,
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

  test("UI URL uses PORT or default 6056", () => {
    expect(resolveUiUrl({})).toBe("http://127.0.0.1:6056/")
    expect(resolveUiUrl({ PORT: "4300" })).toBe("http://127.0.0.1:4300/")
  })

  test("browser open command is platform-appropriate", () => {
    expect(browserOpenCommand("linux", "http://127.0.0.1:6056/")).toEqual({
      command: "xdg-open",
      args: ["http://127.0.0.1:6056/"],
    })
  })
})

describe("launchDetachedBrowser", () => {
  test("registers error handler before unref", () => {
    const order: string[] = []
    const spawnImpl: BrowserSpawn = () => ({
      on(event) {
        if (event === "error") {
          order.push("on-error")
        }
        return undefined
      },
      unref() {
        order.push("unref")
        return undefined
      },
    })

    launchDetachedBrowser("linux", "http://127.0.0.1:6056/", spawnImpl)
    expect(order).toEqual(["on-error", "unref"])
  })

  test("swallows asynchronous spawn errors without throwing", async () => {
    let errorListener: ((error: Error) => void) | undefined
    const spawnImpl: BrowserSpawn = () => ({
      on(event, listener) {
        if (event === "error") {
          errorListener = listener
        }
        return undefined
      },
      unref() {
        return undefined
      },
    })

    expect(() =>
      launchDetachedBrowser("linux", "http://127.0.0.1:6056/", spawnImpl),
    ).not.toThrow()
    expect(errorListener).toBeTypeOf("function")
    expect(() => errorListener?.(new Error("ENOENT"))).not.toThrow()
    await Bun.sleep(0)
  })

  test("swallows synchronous spawn throws without throwing", () => {
    const spawnImpl: BrowserSpawn = () => {
      throw new Error("spawn sync failure")
    }
    expect(() =>
      launchDetachedBrowser("linux", "http://127.0.0.1:6056/", spawnImpl),
    ).not.toThrow()
  })
})
