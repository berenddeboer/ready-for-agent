import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MutationObserver, QueryClient } from "@tanstack/react-query"
import {
  followGithubThrottleErrors,
  githubThrottledRetryAtFromError,
  laterGithubThrottleDeadline,
} from "../src/github-throttle-errors.js"
import { describe, expect, test } from "bun:test"

const NOW_MS = Date.parse("2026-08-13T12:00:00.000Z")
const FUTURE_ISO = "2026-08-13T12:05:00.000Z"
const LATER_ISO = "2026-08-13T12:10:00.000Z"
const PAST_ISO = "2026-08-13T11:59:00.000Z"
const FUTURE_MS = Date.parse(FUTURE_ISO)
const LATER_MS = Date.parse(LATER_ISO)
const PAST_MS = Date.parse(PAST_ISO)

const genqlError = (extensions: Record<string, unknown>): Error => {
  const error = new Error("GitHub is throttling Harness requests") as Error & {
    errors: ReadonlyArray<{ extensions?: Record<string, unknown> }>
  }
  error.errors = [{ extensions }]
  return error
}

const createClock = (startMs: number) => {
  let nowMs = startMs
  const hides: Array<{
    atMs: number
    callback: () => void
    cancelled: boolean
  }> = []
  return {
    now: () => nowMs,
    scheduleHide: (callback: () => void, delayMs: number) => {
      const entry = { atMs: nowMs + delayMs, callback, cancelled: false }
      hides.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    advance: (deltaMs: number) => {
      nowMs += deltaMs
      for (const entry of hides) {
        if (!entry.cancelled && entry.atMs <= nowMs) {
          entry.cancelled = true
          entry.callback()
        }
      }
    },
  }
}

describe("githubThrottledRetryAtFromError", () => {
  test("returns a future ISO deadline from epoch millis", () => {
    expect(
      githubThrottledRetryAtFromError(
        genqlError({ code: "GITHUB_THROTTLED", retryAt: FUTURE_MS }),
        NOW_MS,
      ),
    ).toBe(FUTURE_ISO)
  })

  test("normalizes a future ISO retryAt", () => {
    expect(
      githubThrottledRetryAtFromError(
        genqlError({
          code: "GITHUB_THROTTLED",
          retryAt: "2026-08-13T12:05:00.000Z",
        }),
        NOW_MS,
      ),
    ).toBe(FUTURE_ISO)
  })

  test("returns null for a past deadline", () => {
    expect(
      githubThrottledRetryAtFromError(
        genqlError({ code: "GITHUB_THROTTLED", retryAt: PAST_MS }),
        NOW_MS,
      ),
    ).toBeNull()
    expect(
      githubThrottledRetryAtFromError(
        genqlError({ code: "GITHUB_THROTTLED", retryAt: PAST_ISO }),
        NOW_MS,
      ),
    ).toBeNull()
  })

  test("returns null for other GraphQL errors", () => {
    expect(
      githubThrottledRetryAtFromError(
        genqlError({ code: "INTERNAL_SERVER_ERROR", retryAt: FUTURE_MS }),
        NOW_MS,
      ),
    ).toBeNull()
    expect(
      githubThrottledRetryAtFromError(new Error("boom"), NOW_MS),
    ).toBeNull()
    expect(
      githubThrottledRetryAtFromError("GITHUB_THROTTLED", NOW_MS),
    ).toBeNull()
  })
})

describe("laterGithubThrottleDeadline", () => {
  test("keeps the later deadline", () => {
    expect(laterGithubThrottleDeadline(FUTURE_ISO, LATER_ISO)).toBe(LATER_ISO)
    expect(laterGithubThrottleDeadline(LATER_ISO, FUTURE_ISO)).toBe(LATER_ISO)
    expect(laterGithubThrottleDeadline(null, FUTURE_ISO)).toBe(FUTURE_ISO)
    expect(laterGithubThrottleDeadline(FUTURE_ISO, null)).toBe(FUTURE_ISO)
  })
})

describe("followGithubThrottleErrors", () => {
  test("shows a query-cache GITHUB_THROTTLED error and hides it when the deadline elapses", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const clock = createClock(NOW_MS)
    const seen: Array<string | null> = []
    const stop = followGithubThrottleErrors({
      queryClient,
      onRetryAtChange: (retryAt) => {
        seen.push(retryAt)
      },
      now: clock.now,
      scheduleHide: clock.scheduleHide,
    })

    await queryClient
      .fetchQuery({
        queryKey: ["open-pull-request-counts"],
        queryFn: async () => {
          throw genqlError({ code: "GITHUB_THROTTLED", retryAt: FUTURE_MS })
        },
      })
      .catch(() => undefined)

    expect(seen.at(-1)).toBe(FUTURE_ISO)

    clock.advance(5 * 60_000)
    expect(seen.at(-1)).toBeNull()

    stop()
  })

  test("replaces an earlier deadline and ignores an earlier one", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const clock = createClock(NOW_MS)
    const seen: Array<string | null> = []
    const stop = followGithubThrottleErrors({
      queryClient,
      onRetryAtChange: (retryAt) => {
        seen.push(retryAt)
      },
      now: clock.now,
      scheduleHide: clock.scheduleHide,
    })

    await queryClient
      .fetchQuery({
        queryKey: ["first"],
        queryFn: async () => {
          throw genqlError({ code: "GITHUB_THROTTLED", retryAt: FUTURE_MS })
        },
      })
      .catch(() => undefined)
    await queryClient
      .fetchQuery({
        queryKey: ["second"],
        queryFn: async () => {
          throw genqlError({ code: "GITHUB_THROTTLED", retryAt: LATER_MS })
        },
      })
      .catch(() => undefined)
    await queryClient
      .fetchQuery({
        queryKey: ["third"],
        queryFn: async () => {
          throw genqlError({ code: "GITHUB_THROTTLED", retryAt: FUTURE_MS })
        },
      })
      .catch(() => undefined)

    expect(seen.filter((value) => value !== null)).toEqual([
      FUTURE_ISO,
      LATER_ISO,
    ])

    clock.advance(5 * 60_000)
    expect(seen.at(-1)).toBe(LATER_ISO)

    clock.advance(5 * 60_000)
    expect(seen.at(-1)).toBeNull()

    stop()
  })

  test("picks up a mutation-cache GITHUB_THROTTLED error", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    const clock = createClock(NOW_MS)
    const seen: Array<string | null> = []
    const stop = followGithubThrottleErrors({
      queryClient,
      onRetryAtChange: (retryAt) => {
        seen.push(retryAt)
      },
      now: clock.now,
      scheduleHide: clock.scheduleHide,
    })

    const observer = new MutationObserver(queryClient, {
      mutationFn: async () => {
        throw genqlError({ code: "GITHUB_THROTTLED", retryAt: FUTURE_ISO })
      },
    })
    await observer.mutate().catch(() => undefined)

    expect(seen.at(-1)).toBe(FUTURE_ISO)
    stop()
  })

  test("does not show the banner for other errors", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const seen: Array<string | null> = []
    const stop = followGithubThrottleErrors({
      queryClient,
      onRetryAtChange: (retryAt) => {
        seen.push(retryAt)
      },
      now: () => NOW_MS,
    })

    await queryClient
      .fetchQuery({
        queryKey: ["other"],
        queryFn: async () => {
          throw genqlError({ code: "INTERNAL_SERVER_ERROR" })
        },
      })
      .catch(() => undefined)

    expect(seen).toEqual([])
    stop()
  })
})

describe("root throttle banner wiring (issue #1003)", () => {
  test("does not poll githubThrottleStatus", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/routes/__root.tsx"),
      "utf8",
    )
    expect(source).not.toContain("refetchInterval")
    expect(source).not.toContain("githubThrottleStatus")
    expect(source).toContain("useGithubThrottleRetryAt")
  })
})
