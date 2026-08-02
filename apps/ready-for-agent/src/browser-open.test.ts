import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import {
  type BrowserSpawn,
  browserOpenCommand,
  launchDetachedBrowser,
  openBrowserWhenReady,
  resolveUiUrl,
  shouldOpenBrowser,
} from "./browser-open.ts"

/** Spin until a side-effect counter reaches `n` (real Promise probes). */
const waitForCount = (read: () => number, n: number) =>
  Effect.gen(function* () {
    while (read() < n) {
      yield* Effect.yieldNow
    }
  })

describe("browser open policy", () => {
  it("opens by default", () => {
    expect(shouldOpenBrowser({ noOpenFlag: false, env: {} })).toBe(true)
  })

  it("--no-open disables browser open", () => {
    expect(shouldOpenBrowser({ noOpenFlag: true, env: {} })).toBe(false)
  })

  it("NO_BROWSER disables browser open", () => {
    expect(
      shouldOpenBrowser({ noOpenFlag: false, env: { NO_BROWSER: "1" } }),
    ).toBe(false)
    expect(
      shouldOpenBrowser({ noOpenFlag: false, env: { NO_BROWSER: "true" } }),
    ).toBe(false)
  })

  it("explicit false-like NO_BROWSER keeps open enabled", () => {
    expect(
      shouldOpenBrowser({ noOpenFlag: false, env: { NO_BROWSER: "0" } }),
    ).toBe(true)
    expect(
      shouldOpenBrowser({ noOpenFlag: false, env: { NO_BROWSER: "false" } }),
    ).toBe(true)
  })

  it("UI URL uses PORT or default 6056", () => {
    expect(resolveUiUrl({})).toBe("http://127.0.0.1:6056/")
    expect(resolveUiUrl({ PORT: "4300" })).toBe("http://127.0.0.1:4300/")
  })

  it("browser open command is platform-appropriate", () => {
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
  it("registers error handler before unref", () => {
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

  it("swallows asynchronous spawn errors without throwing", async () => {
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
    await Promise.resolve()
  })

  it("swallows synchronous spawn throws without throwing", () => {
    const spawnImpl: BrowserSpawn = () => {
      throw new Error("spawn sync failure")
    }
    expect(() =>
      launchDetachedBrowser("linux", "http://127.0.0.1:6056/", spawnImpl),
    ).not.toThrow()
  })
})

describe("openBrowserWhenReady", () => {
  it.effect("launches at most once after readiness is observed", () =>
    Effect.gen(function* () {
      let fetches = 0
      let launches = 0
      const fiber = yield* Effect.forkChild(
        openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
          fetch: async () => {
            fetches += 1
            return { status: 200, body: null }
          },
          launch: () => {
            launches += 1
          },
        }),
      )
      // Probe completes, then the post-readiness 1ms sleep parks on TestClock.
      yield* waitForCount(() => fetches, 1)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(fiber)
      expect(fetches).toBe(1)
      expect(launches).toBe(1)
    }),
  )

  it.effect("stops the readiness poll when the fiber is interrupted", () =>
    Effect.gen(function* () {
      let fetches = 0
      let launches = 0
      const fiber = yield* Effect.forkChild(
        openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
          fetch: async () => {
            fetches += 1
            throw new Error("ECONNREFUSED")
          },
          launch: () => {
            launches += 1
          },
        }),
      )
      // Wait until the first real Promise probe has run (and failed) so the
      // fiber is past tryPromise before we interrupt.
      yield* waitForCount(() => fetches, 1)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(launches).toBe(0)
      expect(fetches).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("aborts an in-flight probe when the fiber is interrupted", () =>
    Effect.gen(function* () {
      let launches = 0
      // Hang the probe until interrupted; tryPromise aborts the AbortSignal.
      const fiber = yield* Effect.forkChild(
        openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
          fetch: (_url, init) =>
            new Promise((_resolve, reject) => {
              const signal = init?.signal
              if (signal === undefined) {
                return
              }
              if (signal.aborted) {
                reject(new Error("aborted"))
                return
              }
              signal.addEventListener(
                "abort",
                () => {
                  reject(new Error("aborted"))
                },
                { once: true },
              )
            }),
          launch: () => {
            launches += 1
          },
        }),
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(launches).toBe(0)
    }),
  )

  it.effect(
    "does not launch when interrupted after readiness is observed",
    () =>
      Effect.gen(function* () {
        let fetches = 0
        let launches = 0
        const fiber = yield* Effect.forkChild(
          openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
            fetch: async () => {
              fetches += 1
              return { status: 200, body: null }
            },
            launch: () => {
              launches += 1
            },
          }),
        )
        // Successful probe completes; fiber parks on the 1ms post-readiness
        // sleep (TestClock). Interrupt before advancing the clock so launch
        // never runs — Effect-native stand-in for the old AbortSignal check.
        yield* waitForCount(() => fetches, 1)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.hasInterrupts(exit)).toBe(true)
        expect(launches).toBe(0)
        expect(fetches).toBe(1)
      }),
  )

  it.effect("opener failure does not fail the readiness task", () =>
    Effect.gen(function* () {
      let fetches = 0
      const fiber = yield* Effect.forkChild(
        openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
          fetch: async () => {
            fetches += 1
            return { status: 200, body: null }
          },
          launch: () => {
            throw new Error("opener failed")
          },
        }),
      )
      yield* waitForCount(() => fetches, 1)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(fiber)
    }),
  )

  it.effect("polls until ready then launches once", () =>
    Effect.gen(function* () {
      let fetches = 0
      let launches = 0
      const fiber = yield* Effect.forkChild(
        openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
          fetch: async () => {
            fetches += 1
            if (fetches < 3) {
              throw new Error("not ready")
            }
            return { status: 200, body: null }
          },
          launch: () => {
            launches += 1
          },
        }),
      )
      // Each spaced delay is registered only after its preceding probe
      // Promise settles — wait for that before advancing TestClock.
      yield* waitForCount(() => fetches, 1)
      yield* Effect.yieldNow
      yield* TestClock.adjust("250 millis")
      yield* waitForCount(() => fetches, 2)
      yield* Effect.yieldNow
      yield* TestClock.adjust("250 millis")
      // Third probe succeeds; advance past the post-readiness 1ms sleep.
      yield* waitForCount(() => fetches, 3)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(fiber)
      expect(fetches).toBe(3)
      expect(launches).toBe(1)
    }),
  )

  it.effect("gives up after the overall readiness timeout", () =>
    Effect.gen(function* () {
      let fetches = 0
      let launches = 0
      const fiber = yield* Effect.forkChild(
        openBrowserWhenReady("linux", "http://127.0.0.1:6056/", {
          fetch: async () => {
            fetches += 1
            throw new Error("never ready")
          },
          launch: () => {
            launches += 1
          },
        }),
      )
      yield* waitForCount(() => fetches, 1)
      yield* Effect.yieldNow
      yield* TestClock.adjust("60 seconds")
      yield* Fiber.join(fiber)
      expect(launches).toBe(0)
    }),
  )
})
