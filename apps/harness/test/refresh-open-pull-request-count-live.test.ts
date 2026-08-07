import { QueryClient } from "@tanstack/react-query"
import {
  OPEN_PULL_REQUEST_COUNT_POLL_INTERVAL_MS,
  followOpenPullRequestCountLive,
  openPullRequestCountPresentation,
  openPullRequestCountsQueryKey,
} from "../src/refresh-open-pull-request-count-live.js"
import { describe, expect, test } from "bun:test"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error("condition did not become true")
}

describe("openPullRequestCountPresentation", () => {
  test("shows a known count with singular or plural label", () => {
    expect(
      openPullRequestCountPresentation({
        count: 1,
        isPending: false,
        isFetching: false,
      }),
    ).toEqual({
      label: "1 open pull request",
      display: "1",
      loading: false,
    })
    expect(
      openPullRequestCountPresentation({
        count: 0,
        isPending: false,
        isFetching: true,
      }),
    ).toEqual({
      label: "0 open pull requests",
      display: "0",
      loading: false,
    })
  })

  test("treats a missing count as loading while pending or fetching", () => {
    expect(
      openPullRequestCountPresentation({
        count: undefined,
        isPending: true,
        isFetching: false,
      }),
    ).toMatchObject({ display: "…", loading: true })
    // Stale shared map after add-repo: isPending false, isFetching true.
    expect(
      openPullRequestCountPresentation({
        count: undefined,
        isPending: false,
        isFetching: true,
      }),
    ).toEqual({
      label: "Loading open pull requests",
      display: "…",
      loading: true,
    })
  })

  test("marks a missing count unavailable only when settled", () => {
    expect(
      openPullRequestCountPresentation({
        count: undefined,
        isPending: false,
        isFetching: false,
      }),
    ).toEqual({
      label: "Open pull requests unavailable",
      display: "—",
      loading: false,
    })
  })
})

describe("followOpenPullRequestCountLive", () => {
  test("exports a positive poll interval for GitHub-backed counts", () => {
    expect(OPEN_PULL_REQUEST_COUNT_POLL_INTERVAL_MS).toBe(120_000)
  })

  test("retains a last-known count map after a later count fetch fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let calls = 0
    const openPullRequestCountsQuery = {
      queryKey: openPullRequestCountsQueryKey,
      queryFn: async () => {
        calls += 1
        if (calls === 1) return { "repo-1": 4 }
        throw new Error("GitHub throttled")
      },
    }

    await queryClient.fetchQuery(openPullRequestCountsQuery)
    await expect(
      queryClient.fetchQuery({ ...openPullRequestCountsQuery, staleTime: 0 }),
    ).rejects.toThrow("GitHub throttled")

    const data = queryClient.getQueryData<Readonly<Record<string, number>>>(
      openPullRequestCountsQuery.queryKey,
    )
    expect(data).toEqual({ "repo-1": 4 })
    expect(
      openPullRequestCountPresentation({
        count: data?.["repo-1"],
        isPending: false,
        isFetching: false,
      }),
    ).toMatchObject({ display: "4", loading: false })
  })

  test("settles a first failed count fetch as unavailable rather than zero", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const openPullRequestCountsQuery = {
      queryKey: openPullRequestCountsQueryKey,
      queryFn: async () => {
        throw new Error("GitHub throttled")
      },
    }

    await expect(
      queryClient.fetchQuery(openPullRequestCountsQuery),
    ).rejects.toThrow("GitHub throttled")

    const data = queryClient.getQueryData<Readonly<Record<string, number>>>(
      openPullRequestCountsQuery.queryKey,
    )
    expect(data).toBeUndefined()
    expect(
      openPullRequestCountPresentation({
        count: data?.["repo-1"],
        isPending: false,
        isFetching: false,
      }),
    ).toEqual({
      label: "Open pull requests unavailable",
      display: "—",
      loading: false,
    })
  })

  test("uses a dedicated query key distinct from repositories", () => {
    expect(openPullRequestCountsQueryKey).toEqual(["open-pull-request-counts"])
    expect(openPullRequestCountsQueryKey).not.toEqual(["repositories"])
  })

  test("visibility refresh retains the last known count after throttling", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let countFetches = 0
    let repositoryFetches = 0
    const openPullRequestCountsQuery = {
      queryKey: openPullRequestCountsQueryKey,
      queryFn: async () => {
        countFetches += 1
        if (countFetches === 1) return { "repo-1": 4 }
        throw new Error("GitHub throttled")
      },
    }
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        repositoryFetches += 1
        return [{ id: "repo-1" }]
      },
    }
    await queryClient.fetchQuery(openPullRequestCountsQuery)
    await queryClient.fetchQuery(repositoriesQuery)
    repositoryFetches = 0

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
      openPullRequestCountsQuery,
      signal: controller.signal,
      documentRef,
      pollIntervalMs: 60_000,
    })

    visibilityState = "visible"
    listeners.get("visibilitychange")?.(new Event("visibilitychange"))
    await waitFor(
      () =>
        countFetches === 2 &&
        queryClient.getQueryState(openPullRequestCountsQuery.queryKey)
          ?.fetchStatus === "idle",
    )

    expect(
      queryClient.getQueryData<Readonly<Record<string, number>>>(
        openPullRequestCountsQuery.queryKey,
      ),
    ).toEqual({ "repo-1": 4 })
    expect(repositoryFetches).toBe(0)

    controller.abort()
    await follower
    expect(
      queryClient.getQueryData<Readonly<Record<string, number>>>(
        openPullRequestCountsQuery.queryKey,
      ),
    ).toEqual({ "repo-1": 4 })
  })

  test("refetches only the dedicated count projection when the tab becomes visible", async () => {
    const queryClient = new QueryClient()
    let countFetches = 0
    let repositoryFetches = 0
    const openPullRequestCountsQuery = {
      queryKey: openPullRequestCountsQueryKey,
      queryFn: async () => {
        countFetches += 1
        return {}
      },
    }
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        repositoryFetches += 1
        return []
      },
    }
    // Seed repositories so any accidental cancel/refetch would be observable.
    await queryClient.fetchQuery(repositoriesQuery)
    repositoryFetches = 0

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
      openPullRequestCountsQuery,
      signal: controller.signal,
      documentRef,
      pollIntervalMs: 60_000,
    })

    await wait(20)
    expect(countFetches).toBe(0)
    expect(repositoryFetches).toBe(0)

    visibilityState = "visible"
    listeners.get("visibilitychange")?.(new Event("visibilitychange"))
    await wait(20)
    expect(countFetches).toBe(1)
    expect(repositoryFetches).toBe(0)
    expect(
      queryClient.getQueryState(repositoriesQuery.queryKey)?.dataUpdatedAt,
    ).toBeGreaterThan(0)

    controller.abort()
    await follower
  })

  test("polls only the dedicated count projection while visible", async () => {
    const queryClient = new QueryClient()
    let countFetches = 0
    let repositoryFetches = 0
    const openPullRequestCountsQuery = {
      queryKey: openPullRequestCountsQueryKey,
      queryFn: async () => {
        countFetches += 1
        return {}
      },
    }
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        repositoryFetches += 1
        return []
      },
    }
    await queryClient.fetchQuery(repositoriesQuery)
    repositoryFetches = 0

    const documentRef = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: () => {},
      removeEventListener: () => {},
    }

    const controller = new AbortController()
    const follower = followOpenPullRequestCountLive({
      queryClient,
      openPullRequestCountsQuery,
      signal: controller.signal,
      documentRef,
      pollIntervalMs: 30,
    })

    await wait(100)
    expect(countFetches).toBeGreaterThanOrEqual(2)
    expect(repositoryFetches).toBe(0)

    controller.abort()
    await follower
  })

  test("skips periodic poll ticks while the tab is hidden", async () => {
    const queryClient = new QueryClient()
    let fetches = 0
    const openPullRequestCountsQuery = {
      queryKey: openPullRequestCountsQueryKey,
      queryFn: async () => {
        fetches += 1
        return {}
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
      openPullRequestCountsQuery,
      signal: controller.signal,
      documentRef,
      pollIntervalMs: 20,
    })

    await wait(70)
    expect(fetches).toBe(0)

    controller.abort()
    await follower
  })

  test("keeps polling after a failed count fetch without touching repositories", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    })
    let countFetches = 0
    let repositoryFetches = 0
    const openPullRequestCountsQuery = {
      queryKey: openPullRequestCountsQueryKey,
      queryFn: async () => {
        countFetches += 1
        if (countFetches === 1) {
          throw new Error("transient GraphQL failure")
        }
        return {}
      },
    }
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        repositoryFetches += 1
        return []
      },
    }
    await queryClient.fetchQuery(repositoriesQuery)
    repositoryFetches = 0

    const documentRef = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: () => {},
      removeEventListener: () => {},
    }

    const controller = new AbortController()
    const follower = followOpenPullRequestCountLive({
      queryClient,
      openPullRequestCountsQuery,
      signal: controller.signal,
      documentRef,
      pollIntervalMs: 30,
    })

    await wait(100)
    expect(countFetches).toBeGreaterThanOrEqual(2)
    expect(repositoryFetches).toBe(0)

    controller.abort()
    await follower
  })

  test("abort does not cancel an in-flight repositories query", async () => {
    const queryClient = new QueryClient()
    let repositoriesCompleted = false
    let repositoriesCanceled = false

    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        await wait(80)
        repositoriesCompleted = true
        return [{ id: "repo-1" }]
      },
    }

    // Seed cache then start a long-running repositories refetch that must
    // complete even when the count follower aborts and cancels its own key.
    await queryClient.fetchQuery(repositoriesQuery)
    repositoriesCompleted = false
    const repositoriesRefetch = queryClient
      .fetchQuery({ ...repositoriesQuery, staleTime: 0 })
      .then(() => {
        repositoriesCompleted = true
      })
      .catch(() => {
        repositoriesCanceled = true
      })

    const openPullRequestCountsQuery = {
      queryKey: openPullRequestCountsQueryKey,
      queryFn: async () => {
        await wait(200)
        return {}
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
      openPullRequestCountsQuery,
      signal: controller.signal,
      documentRef,
      pollIntervalMs: 60_000,
    })

    await wait(10)
    controller.abort()
    await follower
    await repositoriesRefetch

    expect(repositoriesCanceled).toBe(false)
    expect(repositoriesCompleted).toBe(true)
  })
})
