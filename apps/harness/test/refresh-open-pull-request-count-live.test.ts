import { QueryClient } from "@tanstack/react-query"
import {
  OPEN_PULL_REQUEST_COUNT_POLL_INTERVAL_MS,
  followOpenPullRequestCountLive,
} from "../src/refresh-open-pull-request-count-live.js"
import { describe, expect, test } from "bun:test"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("followOpenPullRequestCountLive", () => {
  test("exports a positive poll interval for GitHub-backed counts", () => {
    expect(OPEN_PULL_REQUEST_COUNT_POLL_INTERVAL_MS).toBeGreaterThan(0)
  })

  test("refetches repositories immediately when the tab becomes visible", async () => {
    const queryClient = new QueryClient()
    let fetches = 0
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        fetches += 1
        return []
      },
    }

    let visibilityState: DocumentVisibilityState = "hidden"
    const listeners = new Map<string, EventListener>()
    const documentRef = {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: (type: string, listener: EventListener) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }

    const controller = new AbortController()
    const follower = followOpenPullRequestCountLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      documentRef,
      pollIntervalMs: 60_000,
    })

    await wait(20)
    expect(fetches).toBe(0)

    visibilityState = "visible"
    listeners.get("visibilitychange")?.(new Event("visibilitychange"))
    await wait(20)
    expect(fetches).toBe(1)

    controller.abort()
    await follower
  })

  test("polls while visible so external PR changes update without browser refresh", async () => {
    const queryClient = new QueryClient()
    let fetches = 0
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        fetches += 1
        return []
      },
    }

    const documentRef = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: () => {},
      removeEventListener: () => {},
    }

    const controller = new AbortController()
    const follower = followOpenPullRequestCountLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      documentRef,
      pollIntervalMs: 30,
    })

    await wait(100)
    expect(fetches).toBeGreaterThanOrEqual(2)

    controller.abort()
    await follower
  })

  test("skips periodic poll ticks while the tab is hidden", async () => {
    const queryClient = new QueryClient()
    let fetches = 0
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        fetches += 1
        return []
      },
    }

    const documentRef = {
      visibilityState: "hidden" as DocumentVisibilityState,
      addEventListener: () => {},
      removeEventListener: () => {},
    }

    const controller = new AbortController()
    const follower = followOpenPullRequestCountLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      documentRef,
      pollIntervalMs: 20,
    })

    await wait(70)
    expect(fetches).toBe(0)

    controller.abort()
    await follower
  })

  test("keeps polling after a failed repositories fetch", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    })
    let fetches = 0
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        fetches += 1
        if (fetches === 1) {
          throw new Error("transient GraphQL failure")
        }
        return []
      },
    }

    const documentRef = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: () => {},
      removeEventListener: () => {},
    }

    const controller = new AbortController()
    const follower = followOpenPullRequestCountLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      documentRef,
      pollIntervalMs: 30,
    })

    await wait(100)
    expect(fetches).toBeGreaterThanOrEqual(2)

    controller.abort()
    await follower
  })
})
