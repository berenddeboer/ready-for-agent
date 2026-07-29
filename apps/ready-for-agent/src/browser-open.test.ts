import {
  type BrowserSpawn,
  browserOpenCommand,
  launchDetachedBrowser,
  openBrowserWhenReady,
  resolveUiUrl,
  shouldOpenBrowser,
} from "./browser-open.ts"
import { describe, expect, test } from "bun:test"

describe("browser open policy", () => {
  test("opens by default", () => {
    expect(shouldOpenBrowser({ noOpenFlag: false, env: {} })).toBe(true)
  })

  test("--no-open disables browser open", () => {
    expect(shouldOpenBrowser({ noOpenFlag: true, env: {} })).toBe(false)
  })

  test("NO_BROWSER disables browser open", () => {
    expect(
      shouldOpenBrowser({ noOpenFlag: false, env: { NO_BROWSER: "1" } }),
    ).toBe(false)
    expect(
      shouldOpenBrowser({ noOpenFlag: false, env: { NO_BROWSER: "true" } }),
    ).toBe(false)
  })

  test("explicit false-like NO_BROWSER keeps open enabled", () => {
    expect(
      shouldOpenBrowser({ noOpenFlag: false, env: { NO_BROWSER: "0" } }),
    ).toBe(true)
    expect(
      shouldOpenBrowser({ noOpenFlag: false, env: { NO_BROWSER: "false" } }),
    ).toBe(true)
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
    expect(browserOpenCommand("darwin", "http://127.0.0.1:6056/")).toEqual({
      command: "open",
      args: ["http://127.0.0.1:6056/"],
    })
    expect(browserOpenCommand("win32", "http://127.0.0.1:6056/")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "http://127.0.0.1:6056/"],
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

describe("openBrowserWhenReady", () => {
  test("launches at most once after readiness is observed", async () => {
    let fetches = 0
    let launches = 0
    await openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
      fetch: async () => {
        fetches += 1
        return { status: 200, body: null }
      },
      launch: () => {
        launches += 1
      },
      sleep: async () => {
        throw new Error("should not poll after launch")
      },
    })
    expect(fetches).toBe(1)
    expect(launches).toBe(1)
  })

  test("stops the readiness poll when the AbortSignal is aborted", async () => {
    const controller = new AbortController()
    let fetches = 0
    let launches = 0

    await openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
      signal: controller.signal,
      fetch: async () => {
        fetches += 1
        throw new Error("ECONNREFUSED")
      },
      sleep: async () => {
        controller.abort()
      },
      launch: () => {
        launches += 1
      },
      timeoutMs: 60_000,
      pollIntervalMs: 1,
    })

    expect(launches).toBe(0)
    expect(fetches).toBe(1)
  })

  test("does not launch when aborted after readiness is observed", async () => {
    const controller = new AbortController()
    let launches = 0

    await openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
      signal: controller.signal,
      fetch: async () => {
        controller.abort()
        return { status: 200, body: null }
      },
      launch: () => {
        launches += 1
      },
    })

    expect(launches).toBe(0)
  })

  test("opener failure does not reject the readiness task", async () => {
    await expect(
      openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
        fetch: async () => ({ status: 200, body: null }),
        launch: () => {
          throw new Error("opener failed")
        },
      }),
    ).resolves.toBeUndefined()
  })

  test("polls until ready then launches once", async () => {
    let fetches = 0
    let launches = 0
    await openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
      fetch: async () => {
        fetches += 1
        if (fetches < 3) {
          throw new Error("not ready")
        }
        return { status: 200, body: null }
      },
      sleep: async () => {},
      launch: () => {
        launches += 1
      },
      timeoutMs: 60_000,
      pollIntervalMs: 1,
    })
    expect(fetches).toBe(3)
    expect(launches).toBe(1)
  })
})
