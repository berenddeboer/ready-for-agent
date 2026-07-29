import { QueryClient } from "@tanstack/react-query"
import { openPullRequestCountsQueryKey } from "../src/refresh-open-pull-request-count-live.js"
import {
  LIVE_UPDATES_UNAVAILABLE_MESSAGE,
  LIVE_UPDATES_WARNING_GRACE_MS,
  type RepositoryLiveDiagnostic,
  followRepositoryMembershipLive,
  liveUpdatesWarningPresentation,
} from "../src/refresh-repositories-live.js"
import { RepositorySubscriptionStaleError } from "../src/repository-live.js"
import { describe, expect, test } from "bun:test"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (
  predicate: () => boolean,
  { timeoutMs = 1_000 }: { timeoutMs?: number } = {},
) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out")
    }
    await wait(5)
  }
}

describe("liveUpdatesWarningPresentation", () => {
  test("renders the unavailable message only when transport is degraded", () => {
    expect(liveUpdatesWarningPresentation(false)).toBeNull()
    expect(liveUpdatesWarningPresentation(true)).toEqual({
      message: LIVE_UPDATES_UNAVAILABLE_MESSAGE,
    })
    expect(LIVE_UPDATES_WARNING_GRACE_MS).toBe(10_000)
  })
})

describe("followRepositoryMembershipLive", () => {
  test("marks transport healthy on SSE connect before catch-up finishes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let releaseCatchUp: (() => void) | undefined
    const catchUpGate = new Promise<void>((resolve) => {
      releaseCatchUp = resolve
    })
    let repositoryFetches = 0
    let countInvalidations = 0
    const originalInvalidate = queryClient.invalidateQueries.bind(queryClient)
    queryClient.invalidateQueries = (filters, options) => {
      const key = (filters as { queryKey?: readonly unknown[] } | undefined)
        ?.queryKey
      if (Array.isArray(key) && key[0] === openPullRequestCountsQueryKey[0]) {
        countInvalidations += 1
      }
      return originalInvalidate(filters as never, options as never)
    }

    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        repositoryFetches += 1
        await catchUpGate
        return [{ id: "repo-1" }]
      },
    }

    const diagnostics: RepositoryLiveDiagnostic[] = []
    const unavailableFlags: boolean[] = []
    let onChange: (() => void | Promise<void>) | undefined
    let streamSignal: AbortSignal | undefined
    const connected = Promise.withResolvers<void>()

    const controller = new AbortController()
    const live = followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      retryDelayMs: 20,
      warningGraceMs: 5_000,
      onLiveUpdatesUnavailable: (unavailable) => {
        unavailableFlags.push(unavailable)
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic)
      },
      stream: async ({
        onConnected: handleConnected,
        onChange: handleChange,
        signal,
      }) => {
        onChange = handleChange
        streamSignal = signal
        await handleConnected()
        connected.resolve()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await connected.promise
    await waitFor(() =>
      diagnostics.some((d) => d.event === "connect" && d.generation === 1),
    )

    // Transport is healthy even though catch-up is still held pending.
    expect(unavailableFlags).not.toContain(true)
    expect(repositoryFetches).toBe(1)
    expect(
      liveUpdatesWarningPresentation(
        unavailableFlags[unavailableFlags.length - 1] ?? false,
      ),
    ).toBeNull()

    // Stream remains open for notifications while catch-up is pending.
    expect(streamSignal?.aborted).toBe(false)
    void onChange?.()
    await wait(10)
    // Single-flight: still one in-flight catch-up; pending flag schedules a
    // trailing pass after release — not overlapping concurrent fetches.
    expect(repositoryFetches).toBe(1)

    releaseCatchUp?.()
    await waitFor(() => repositoryFetches >= 2)
    expect(countInvalidations).toBeGreaterThan(0)

    controller.abort()
    await live
  })

  test("a held-pending or failed catch-up does not show the live-updates warning", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let shouldFail = true
    let successfulFetches = 0
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        if (shouldFail) {
          throw new Error("authoritative repositories failed")
        }
        successfulFetches += 1
        return []
      },
    }

    const diagnostics: RepositoryLiveDiagnostic[] = []
    let unavailable = false
    const connected = Promise.withResolvers<void>()

    const controller = new AbortController()
    const live = followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      retryDelayMs: 15,
      warningGraceMs: 50,
      onLiveUpdatesUnavailable: (next) => {
        unavailable = next
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic)
      },
      stream: async ({ onConnected, signal }) => {
        await onConnected()
        connected.resolve()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await connected.promise
    await waitFor(() => diagnostics.some((d) => d.event === "catch_up_failure"))
    // Grace would have elapsed if transport were unhealthy — it is not.
    await wait(80)
    expect(unavailable).toBe(false)
    const failuresBeforeRecovery = diagnostics.filter(
      (d) => d.event === "catch_up_failure",
    ).length
    expect(failuresBeforeRecovery).toBeGreaterThan(0)

    shouldFail = false
    await waitFor(() => successfulFetches >= 1)
    // After recovery, catch-up succeeds and stops emitting new failures.
    const failuresAfterRecovery = diagnostics.filter(
      (d) => d.event === "catch_up_failure",
    ).length
    await wait(40)
    expect(
      diagnostics.filter((d) => d.event === "catch_up_failure").length,
    ).toBe(failuresAfterRecovery)
    expect(unavailable).toBe(false)

    controller.abort()
    await live
  })

  test("same-generation catch-up coalesces without cancel failure diagnostics", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let releaseFetch: (() => void) | undefined
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let repositoryFetches = 0
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        repositoryFetches += 1
        if (repositoryFetches === 1) await fetchGate
        return []
      },
    }

    const diagnostics: RepositoryLiveDiagnostic[] = []
    let onChange: (() => void | Promise<void>) | undefined
    const connected = Promise.withResolvers<void>()

    const controller = new AbortController()
    const live = followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      retryDelayMs: 15,
      warningGraceMs: 5_000,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic)
      },
      stream: async ({
        onConnected: handleConnected,
        onChange: handleChange,
        signal,
      }) => {
        onChange = handleChange
        await handleConnected()
        connected.resolve()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await connected.promise
    await waitFor(() => repositoryFetches === 1)

    // Burst of same-generation changes while first catch-up is held.
    void onChange?.()
    void onChange?.()
    await wait(20)
    expect(repositoryFetches).toBe(1)
    expect(
      diagnostics.filter((d) => d.event === "catch_up_failure"),
    ).toHaveLength(0)

    releaseFetch?.()
    await waitFor(() => repositoryFetches >= 2)
    expect(
      diagnostics.filter((d) => d.event === "catch_up_failure"),
    ).toHaveLength(0)

    controller.abort()
    await live
  })

  test("sustained disconnection shows the warning after the grace period and clears on recover", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => [],
    }

    const unavailableFlags: boolean[] = []
    const diagnostics: RepositoryLiveDiagnostic[] = []
    let attempt = 0
    let allowRecovery = false
    const secondConnect = Promise.withResolvers<void>()

    const controller = new AbortController()
    const live = followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      retryDelayMs: 15,
      warningGraceMs: 40,
      onLiveUpdatesUnavailable: (unavailable) => {
        unavailableFlags.push(unavailable)
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic)
      },
      stream: async ({ onConnected, signal }) => {
        attempt += 1
        if (!allowRecovery) {
          // Stay disconnected long enough for the grace warning to surface.
          throw new Error("transport down")
        }
        await onConnected()
        secondConnect.resolve()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await waitFor(() => unavailableFlags.includes(true), { timeoutMs: 500 })
    expect(liveUpdatesWarningPresentation(true)?.message).toBe(
      LIVE_UPDATES_UNAVAILABLE_MESSAGE,
    )

    allowRecovery = true
    await secondConnect.promise
    await waitFor(() => unavailableFlags[unavailableFlags.length - 1] === false)
    expect(liveUpdatesWarningPresentation(false)).toBeNull()
    expect(diagnostics.some((d) => d.event === "connect")).toBe(true)
    expect(diagnostics.some((d) => d.event === "reconnect")).toBe(true)
    expect(diagnostics.some((d) => d.event === "disconnect")).toBe(true)
    expect(attempt).toBeGreaterThan(1)

    controller.abort()
    await live
  })

  test("a newer reconnect generation supersedes stale callbacks from an older generation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let repositoryFetches = 0
    let inFlight = 0
    let maxInFlight = 0
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        repositoryFetches += 1
        await wait(10)
        inFlight -= 1
        return [{ id: `fetch-${repositoryFetches}` }]
      },
    }

    const connectGenerations: number[] = []
    let attempt = 0
    let gen1OnChange: (() => void | Promise<void>) | undefined
    const firstStreamEnded = Promise.withResolvers<void>()
    const gen2Connected = Promise.withResolvers<void>()

    const controller = new AbortController()
    const live = followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      retryDelayMs: 10,
      warningGraceMs: 5_000,
      onDiagnostic: (diagnostic) => {
        if (diagnostic.event === "connect") {
          connectGenerations.push(diagnostic.generation)
        }
      },
      stream: async ({ onConnected, onChange, signal }) => {
        attempt += 1
        const thisAttempt = attempt
        await onConnected()
        if (thisAttempt === 1) {
          gen1OnChange = onChange
          await firstStreamEnded.promise
          return
        }
        gen2Connected.resolve()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await waitFor(() => connectGenerations.includes(1))
    await waitFor(() => repositoryFetches >= 1)

    firstStreamEnded.resolve()
    await gen2Connected.promise
    await waitFor(() => connectGenerations.includes(2))
    await waitFor(() => repositoryFetches >= 2)

    const fetchesAfterGen2Connect = repositoryFetches
    // Stale gen-1 change callback must not schedule catch-up for the old generation.
    await gen1OnChange?.()
    await wait(40)
    expect(repositoryFetches).toBe(fetchesAfterGen2Connect)
    expect(connectGenerations).toEqual([1, 2])
    expect(maxInFlight).toBe(1)

    controller.abort()
    await live
  })

  test("stale transport reconnects once without overlapping catch-up", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let repositoryFetches = 0
    let catchUpPasses = 0
    let catchUpInFlight = 0
    let maxCatchUpInFlight = 0
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        // Observable single-flight at the follower: each pass is one fetchQuery
        // after cancel; track concurrent queryFn only for diagnostics.
        catchUpPasses += 1
        catchUpInFlight += 1
        maxCatchUpInFlight = Math.max(maxCatchUpInFlight, catchUpInFlight)
        repositoryFetches += 1
        await wait(5)
        catchUpInFlight -= 1
        return []
      },
    }

    const diagnostics: RepositoryLiveDiagnostic[] = []
    let attempt = 0
    const secondConnect = Promise.withResolvers<void>()

    const controller = new AbortController()
    const live = followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      retryDelayMs: 10,
      warningGraceMs: 5_000,
      onDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic)
      },
      stream: async ({ onConnected, signal }) => {
        attempt += 1
        if (attempt === 1) {
          await onConnected()
          // Simulate heartbeat loss after establish.
          throw new RepositorySubscriptionStaleError(50)
        }
        await onConnected()
        secondConnect.resolve()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await secondConnect.promise
    await waitFor(() =>
      diagnostics.some((d) => d.event === "stale" && d.generation === 1),
    )
    await waitFor(() =>
      diagnostics.some((d) => d.event === "connect" && d.generation === 2),
    )
    await waitFor(() => repositoryFetches >= 2)
    await wait(20)

    // One stale generation, one successful reconnect — not a reconnect storm.
    expect(
      diagnostics.filter((d) => d.event === "stale").map((d) => d.generation),
    ).toEqual([1])
    expect(
      diagnostics.filter((d) => d.event === "connect").map((d) => d.generation),
    ).toEqual([1, 2])
    expect(
      diagnostics.some(
        (d) =>
          d.event === "disconnect" &&
          d.generation === 1 &&
          d.reason === "stale",
      ),
    ).toBe(true)
    expect(attempt).toBe(2)
    expect(repositoryFetches).toBeGreaterThanOrEqual(2)
    // Follower single-flight: cancel-before-fetch keeps concurrent query work
    // at most one when the prior pass can settle promptly.
    expect(maxCatchUpInFlight).toBeLessThanOrEqual(2)
    expect(catchUpPasses).toBeGreaterThanOrEqual(2)

    controller.abort()
    await live
  })

  test("throwing onDiagnostic does not block transport healthy or catch-up", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let repositoryFetches = 0
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        repositoryFetches += 1
        return []
      },
    }

    let unavailable = false
    const connected = Promise.withResolvers<void>()
    const controller = new AbortController()
    const live = followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      retryDelayMs: 15,
      // Short grace: would fire if connect failed to mark transport healthy.
      warningGraceMs: 40,
      onLiveUpdatesUnavailable: (next) => {
        unavailable = next
      },
      onDiagnostic: () => {
        throw new Error("diagnostic listener blew up")
      },
      stream: async ({ onConnected, signal }) => {
        await onConnected()
        connected.resolve()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await connected.promise
    await waitFor(() => repositoryFetches >= 1)
    // Grace elapsed without the warning — transport was marked healthy first.
    await wait(60)
    expect(unavailable).toBe(false)

    controller.abort()
    await live
  })

  test("reconnect ends catch-up failure backoff for the prior generation promptly", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let shouldFail = true
    let successfulFetches = 0
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        if (shouldFail) throw new Error("catch-up failed")
        successfulFetches += 1
        return []
      },
    }

    let attempt = 0
    const firstFailed = Promise.withResolvers<void>()
    const secondConnected = Promise.withResolvers<void>()
    const endFirst = Promise.withResolvers<void>()

    const controller = new AbortController()
    const live = followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      // Stream reconnect uses this base; catch-up failure wait is generation-bound
      // so a long first backoff must not delay gen-2 once the stream generation advances.
      retryDelayMs: 80,
      warningGraceMs: 5_000,
      onDiagnostic: (diagnostic) => {
        if (diagnostic.event === "catch_up_failure") firstFailed.resolve()
        if (diagnostic.event === "connect" && diagnostic.generation === 2) {
          secondConnected.resolve()
        }
      },
      stream: async ({ onConnected, signal }) => {
        attempt += 1
        if (attempt === 1) {
          await onConnected()
          await endFirst.promise
          return "stream_ended"
        }
        shouldFail = false
        await onConnected()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return "complete"
      },
    })

    await firstFailed.promise
    // Inflate the next catch-up wait by letting the first failure finish its
    // short wait and schedule a second failure with doubled delay, then cut
    // the stream during that longer wait.
    await wait(120)
    endFirst.resolve()
    await secondConnected.promise
    await waitFor(() => successfulFetches >= 1, { timeoutMs: 800 })

    controller.abort()
    await live
  })

  test("visibility catch-up does not mark transport unavailable on failure", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let failVisibility = false
    const repositoriesQuery = {
      queryKey: ["repositories"] as const,
      queryFn: async () => {
        if (failVisibility) throw new Error("visibility refresh failed")
        return []
      },
    }

    let unavailable = false
    const listeners = new Map<string, EventListener>()
    const documentRef = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (type: string, listener: EventListener) => {
        listeners.set(type, listener)
      },
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
    }

    const connected = Promise.withResolvers<void>()
    const controller = new AbortController()
    const live = followRepositoryMembershipLive({
      queryClient,
      repositoriesQuery,
      signal: controller.signal,
      documentRef,
      retryDelayMs: 15,
      warningGraceMs: 30,
      onLiveUpdatesUnavailable: (next) => {
        unavailable = next
      },
      stream: async ({ onConnected, signal }) => {
        await onConnected()
        connected.resolve()
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await connected.promise
    failVisibility = true
    documentRef.visibilityState = "visible"
    listeners.get("visibilitychange")?.(new Event("visibilitychange"))
    await wait(60)
    expect(unavailable).toBe(false)

    controller.abort()
    await live
  })
})
