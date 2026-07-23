import { QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  committedPullRequestsCountQueryKeyPrefix,
  followRepositoryWorkItemsLive,
} from "../src/refresh-work-items-live.js"
import { describe, expect, test } from "bun:test"

const observeQuery = (
  queryClient: QueryClient,
  query: {
    queryKey: readonly unknown[]
    queryFn: () => Promise<unknown>
  },
) => {
  const observer = new QueryObserver(queryClient, {
    queryKey: query.queryKey,
    queryFn: query.queryFn,
    staleTime: 0,
  })
  return observer.subscribe(() => undefined)
}

const waitFor = async (
  predicate: () => boolean,
  { timeoutMs = 1_000 }: { timeoutMs?: number } = {},
) => {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out")
    }
    await Bun.sleep(5)
  }
}

describe("Repository Work Item live-query coordination", () => {
  test("an invalidation refetches only the affected Repository Work Items", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const otherRepositoryId = "repo-01JOTHER0000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    let selectedWorkItemsFetches = 0
    let otherWorkItemsFetches = 0
    let selectedWorkItems = [
      {
        id: "wi-before",
        status: "QUEUED",
      },
    ]

    const queries = {
      workItems: (id: string) => ({
        queryKey: ["work-items", id] as const,
        queryFn: async () => {
          if (id === repositoryId) {
            selectedWorkItemsFetches += 1
            return selectedWorkItems
          }
          otherWorkItemsFetches += 1
          return []
        },
      }),
    }

    let releaseInvalidation: (() => void) | undefined
    const invalidation = new Promise<void>((resolve) => {
      releaseInvalidation = resolve
    })
    let onChange: ((repositoryId: string) => void | Promise<void>) | undefined
    let connected: (() => void) | undefined
    const connectedPromise = new Promise<void>((resolve) => {
      connected = resolve
    })

    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId, otherRepositoryId],
      queryClient,
      queries,
      signal: controller.signal,
      retryDelayMs: 10,
      stream: async ({ onConnected, onChange: handleChange, signal }) => {
        onChange = handleChange
        await onConnected()
        connected?.()
        await invalidation
        if (signal.aborted) return
        await handleChange(repositoryId)
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await connectedPromise

    selectedWorkItems = [
      {
        id: "wi-after",
        status: "RUNNING",
      },
    ]
    const fetchesBeforeInvalidation = {
      selectedWorkItems: selectedWorkItemsFetches,
    }
    releaseInvalidation?.()

    await Bun.sleep(20)

    const workItems = queryClient.getQueryData(
      queries.workItems(repositoryId).queryKey,
    )

    expect(workItems).toEqual([
      {
        id: "wi-after",
        status: "RUNNING",
      },
    ])
    expect(selectedWorkItemsFetches).toBeGreaterThan(
      fetchesBeforeInvalidation.selectedWorkItems,
    )
    // Initial connection refetches both displayed Repositories, but the
    // selected invalidation does not refetch the other Repository again.
    expect(otherWorkItemsFetches).toBe(1)
    const selectedWorkItemsBeforeOtherInvalidation = selectedWorkItemsFetches
    const otherWorkItemsBeforeOtherInvalidation = otherWorkItemsFetches
    await onChange?.(otherRepositoryId)
    expect(selectedWorkItemsFetches).toBe(
      selectedWorkItemsBeforeOtherInvalidation,
    )
    expect(otherWorkItemsFetches).toBeGreaterThan(
      otherWorkItemsBeforeOtherInvalidation,
    )
    expect(onChange).toBeDefined()

    controller.abort()
    await live
  })

  test("an invalidation replaces a stale in-flight Work Item fetch", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let resolveStale:
      | ((items: readonly { status: string }[]) => void)
      | undefined
    const staleResponse = new Promise<readonly { status: string }[]>(
      (resolve) => {
        resolveStale = resolve
      },
    )
    let workItemFetches = 0
    const workItemsQuery = {
      queryKey: ["work-items", repositoryId] as const,
      queryFn: async () => {
        workItemFetches += 1
        if (workItemFetches === 1) return staleResponse
        return [{ status: "RUNNING" }]
      },
    }
    let onChange:
      | ((changedRepositoryId: string) => void | Promise<void>)
      | undefined
    let subscribed: (() => void) | undefined
    const subscribedPromise = new Promise<void>((resolve) => {
      subscribed = resolve
    })
    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: () => workItemsQuery,
      },
      signal: controller.signal,
      stream: async ({ onChange: handleChange, signal }) => {
        onChange = handleChange
        subscribed?.()
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await subscribedPromise
    const staleFetch = queryClient.fetchQuery({
      ...workItemsQuery,
      staleTime: 0,
    })
    await Bun.sleep(0)
    expect(workItemFetches).toBe(1)

    await onChange?.(repositoryId)
    expect(workItemFetches).toBe(2)
    expect(queryClient.getQueryData(workItemsQuery.queryKey)).toEqual([
      { status: "RUNNING" },
    ])

    resolveStale?.([{ status: "QUEUED" }])
    await staleFetch.catch(() => undefined)
    expect(queryClient.getQueryData(workItemsQuery.queryKey)).toEqual([
      { status: "RUNNING" },
    ])

    controller.abort()
    await live
  })

  test("tab visibility refetch is a fallback for missed invalidations", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let workItemsFetches = 0
    let visibilityState: DocumentVisibilityState = "hidden"
    const listeners = new Map<string, Set<EventListener>>()

    const documentRef = {
      get visibilityState() {
        return visibilityState
      },
      addEventListener(type: string, listener: EventListener) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener)
      },
    }

    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: (id: string) => ({
          queryKey: ["work-items", id],
          queryFn: async () => {
            if (id === repositoryId) workItemsFetches += 1
            return []
          },
        }),
      },
      signal: controller.signal,
      documentRef,
      stream: async ({ onConnected, signal }) => {
        await onConnected()
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await Bun.sleep(10)
    const workItemsAfterConnect = workItemsFetches
    expect(workItemsAfterConnect).toBeGreaterThan(0)

    visibilityState = "visible"
    for (const listener of listeners.get("visibilitychange") ?? []) {
      listener(new Event("visibilitychange"))
    }
    await Bun.sleep(10)

    expect(workItemsFetches).toBeGreaterThan(workItemsAfterConnect)

    controller.abort()
    await live
    expect(listeners.get("visibilitychange")?.size ?? 0).toBe(0)
  })

  test("an invalidation refetches active committed pull request counts", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let countFetches = 0
    let count = 22
    const todayKey = [
      ...committedPullRequestsCountQueryKeyPrefix,
      "2026-07-22T00:00:00.000Z",
      "2026-07-23T00:00:00.000Z",
    ] as const
    const countQuery = {
      queryKey: todayKey,
      queryFn: async () => {
        countFetches += 1
        return count
      },
    }
    const stopObserving = observeQuery(queryClient, countQuery)
    await queryClient.fetchQuery(countQuery)

    let onChange: ((repositoryId: string) => void | Promise<void>) | undefined
    let connected: (() => void) | undefined
    const connectedPromise = new Promise<void>((resolve) => {
      connected = resolve
    })
    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: (id: string) => ({
          queryKey: ["work-items", id] as const,
          queryFn: async () => [],
        }),
      },
      signal: controller.signal,
      stream: async ({ onConnected, onChange: handleChange, signal }) => {
        onChange = handleChange
        await onConnected()
        connected?.()
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await connectedPromise
    const fetchesAfterConnect = countFetches
    expect(fetchesAfterConnect).toBeGreaterThan(1)
    expect(queryClient.getQueryData(todayKey)).toBe(22)

    count = 23
    await onChange?.(repositoryId)
    await waitFor(() => countFetches > fetchesAfterConnect)
    expect(queryClient.getQueryData(todayKey)).toBe(23)

    controller.abort()
    await live
    stopObserving()
  })

  test("an invalidation skips inactive committed pull request counts", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let countFetches = 0
    const todayKey = [
      ...committedPullRequestsCountQueryKeyPrefix,
      "from",
      "to",
    ] as const
    await queryClient.fetchQuery({
      queryKey: todayKey,
      queryFn: async () => {
        countFetches += 1
        return countFetches
      },
    })
    expect(countFetches).toBe(1)

    let onChange: ((repositoryId: string) => void | Promise<void>) | undefined
    let connected: (() => void) | undefined
    const connectedPromise = new Promise<void>((resolve) => {
      connected = resolve
    })
    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: (id: string) => ({
          queryKey: ["work-items", id] as const,
          queryFn: async () => [],
        }),
      },
      signal: controller.signal,
      stream: async ({ onConnected, onChange: handleChange, signal }) => {
        onChange = handleChange
        await onConnected()
        connected?.()
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await connectedPromise
    expect(countFetches).toBe(1)
    await onChange?.(repositoryId)
    await Bun.sleep(20)
    expect(countFetches).toBe(1)

    controller.abort()
    await live
  })

  test("tab visibility also refetches active committed pull request counts", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let countFetches = 0
    const todayKey = [
      ...committedPullRequestsCountQueryKeyPrefix,
      "from",
      "to",
    ] as const
    const countQuery = {
      queryKey: todayKey,
      queryFn: async () => {
        countFetches += 1
        return countFetches
      },
    }
    const stopObserving = observeQuery(queryClient, countQuery)
    await queryClient.fetchQuery(countQuery)

    let visibilityState: DocumentVisibilityState = "hidden"
    const listeners = new Map<string, Set<EventListener>>()
    const documentRef = {
      get visibilityState() {
        return visibilityState
      },
      addEventListener(type: string, listener: EventListener) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener)
      },
    }

    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: (id: string) => ({
          queryKey: ["work-items", id],
          queryFn: async () => [],
        }),
      },
      signal: controller.signal,
      documentRef,
      stream: async ({ onConnected, signal }) => {
        await onConnected()
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await Bun.sleep(10)
    const afterConnect = countFetches
    expect(afterConnect).toBeGreaterThan(1)

    visibilityState = "visible"
    for (const listener of listeners.get("visibilitychange") ?? []) {
      listener(new Event("visibilitychange"))
    }
    await Bun.sleep(10)

    expect(countFetches).toBeGreaterThan(afterConnect)

    controller.abort()
    await live
    stopObserving()
  })

  test("serial Work Item notifications coalesce count refreshes", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const otherRepositoryId = "repo-01JOTHER0000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let countFetches = 0
    let blockCountFetches = false
    let releaseCountFetch: (() => void) | undefined
    const todayKey = [
      ...committedPullRequestsCountQueryKeyPrefix,
      "from",
      "to",
    ] as const
    const countQuery = {
      queryKey: todayKey,
      queryFn: async () => {
        countFetches += 1
        if (blockCountFetches) {
          await new Promise<void>((resolve) => {
            releaseCountFetch = resolve
          })
        }
        return countFetches
      },
    }
    const stopObserving = observeQuery(queryClient, countQuery)
    await queryClient.fetchQuery(countQuery)

    const pendingEvents: string[] = []
    let wakeEvents: (() => void) | undefined
    let connected: (() => void) | undefined
    const connectedPromise = new Promise<void>((resolve) => {
      connected = resolve
    })
    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId, otherRepositoryId],
      queryClient,
      queries: {
        workItems: (id: string) => ({
          queryKey: ["work-items", id] as const,
          queryFn: async () => [],
        }),
      },
      signal: controller.signal,
      // Mirror production: await each onChange before reading the next event.
      stream: async ({ onConnected, onChange, signal }) => {
        await onConnected()
        connected?.()
        while (!signal.aborted) {
          if (pendingEvents.length === 0) {
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              wakeEvents = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
            wakeEvents = undefined
            continue
          }
          const nextRepositoryId = pendingEvents.shift()
          if (nextRepositoryId === undefined) continue
          await onChange(nextRepositoryId)
        }
      },
    })

    await connectedPromise
    const fetchesAfterConnect = countFetches
    expect(fetchesAfterConnect).toBeGreaterThan(1)

    blockCountFetches = true
    pendingEvents.push(repositoryId, otherRepositoryId)
    wakeEvents?.()

    await waitFor(() => countFetches === fetchesAfterConnect + 1)
    // Both serial events were handled (work-items path finished) while one
    // count refresh remains gated — second event only marked a trailing pass.
    await waitFor(() => pendingEvents.length === 0)
    expect(countFetches).toBe(fetchesAfterConnect + 1)

    blockCountFetches = false
    releaseCountFetch?.()
    await waitFor(() => countFetches === fetchesAfterConnect + 2)

    controller.abort()
    await live
    stopObserving()
  })

  test("failed count refreshes keep retrying until success", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let countFetches = 0
    let remainingFailures = 0
    const todayKey = [
      ...committedPullRequestsCountQueryKeyPrefix,
      "from",
      "to",
    ] as const
    const countQuery = {
      queryKey: todayKey,
      queryFn: async () => {
        countFetches += 1
        if (remainingFailures > 0) {
          remainingFailures -= 1
          throw new Error("count refresh failed")
        }
        return countFetches
      },
    }
    const stopObserving = observeQuery(queryClient, countQuery)
    await queryClient.fetchQuery(countQuery)

    const pendingEvents: string[] = []
    let wakeEvents: (() => void) | undefined
    let connected: (() => void) | undefined
    const connectedPromise = new Promise<void>((resolve) => {
      connected = resolve
    })
    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: (id: string) => ({
          queryKey: ["work-items", id] as const,
          queryFn: async () => [],
        }),
      },
      signal: controller.signal,
      retryDelayMs: 15,
      stream: async ({ onConnected, onChange, signal }) => {
        await onConnected()
        connected?.()
        while (!signal.aborted) {
          if (pendingEvents.length === 0) {
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              wakeEvents = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
            wakeEvents = undefined
            continue
          }
          const nextRepositoryId = pendingEvents.shift()
          if (nextRepositoryId === undefined) continue
          await onChange(nextRepositoryId)
        }
      },
    })

    await connectedPromise
    const fetchesAfterConnect = countFetches

    remainingFailures = 2
    pendingEvents.push(repositoryId)
    wakeEvents?.()
    await waitFor(() => pendingEvents.length === 0)
    // Two delayed retries after the first failed event-triggered pass.
    await waitFor(() => countFetches === fetchesAfterConnect + 3)
    expect(queryClient.getQueryData(todayKey)).toBe(fetchesAfterConnect + 3)

    controller.abort()
    await live
    stopObserving()
  })

  test("a second visibility refresh runs a trailing pass", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let countFetches = 0
    let blockCountFetches = false
    let releaseCountFetch: (() => void) | undefined
    const todayKey = [
      ...committedPullRequestsCountQueryKeyPrefix,
      "from",
      "to",
    ] as const
    const countQuery = {
      queryKey: todayKey,
      queryFn: async () => {
        countFetches += 1
        if (blockCountFetches) {
          await new Promise<void>((resolve) => {
            releaseCountFetch = resolve
          })
        }
        return countFetches
      },
    }
    const stopObserving = observeQuery(queryClient, countQuery)
    await queryClient.fetchQuery(countQuery)

    let visibilityState: DocumentVisibilityState = "hidden"
    const listeners = new Map<string, Set<EventListener>>()
    const documentRef = {
      get visibilityState() {
        return visibilityState
      },
      addEventListener(type: string, listener: EventListener) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener)
      },
    }

    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: (id: string) => ({
          queryKey: ["work-items", id],
          queryFn: async () => [],
        }),
      },
      signal: controller.signal,
      documentRef,
      stream: async ({ onConnected, signal }) => {
        await onConnected()
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await Bun.sleep(10)
    const afterConnect = countFetches
    blockCountFetches = true
    visibilityState = "visible"
    for (const listener of listeners.get("visibilitychange") ?? []) {
      listener(new Event("visibilitychange"))
    }
    await waitFor(() => countFetches === afterConnect + 1)

    // Second visibility pulse while the first full refresh is still gated.
    for (const listener of listeners.get("visibilitychange") ?? []) {
      listener(new Event("visibilitychange"))
    }
    await Bun.sleep(10)
    expect(countFetches).toBe(afterConnect + 1)

    blockCountFetches = false
    releaseCountFetch?.()
    await waitFor(() => countFetches === afterConnect + 2)

    controller.abort()
    await live
    stopObserving()
  })

  test("abort stops trailing committed count refreshes", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let countFetches = 0
    let blockCountFetches = false
    let releaseCountFetch: (() => void) | undefined
    const todayKey = [
      ...committedPullRequestsCountQueryKeyPrefix,
      "from",
      "to",
    ] as const
    const countQuery = {
      queryKey: todayKey,
      queryFn: async () => {
        countFetches += 1
        if (blockCountFetches) {
          await new Promise<void>((resolve) => {
            releaseCountFetch = resolve
          })
        }
        return countFetches
      },
    }
    const stopObserving = observeQuery(queryClient, countQuery)
    await queryClient.fetchQuery(countQuery)

    const pendingEvents: string[] = []
    let wakeEvents: (() => void) | undefined
    let connected: (() => void) | undefined
    const connectedPromise = new Promise<void>((resolve) => {
      connected = resolve
    })
    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: (id: string) => ({
          queryKey: ["work-items", id] as const,
          queryFn: async () => [],
        }),
      },
      signal: controller.signal,
      stream: async ({ onConnected, onChange, signal }) => {
        await onConnected()
        connected?.()
        while (!signal.aborted) {
          if (pendingEvents.length === 0) {
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              wakeEvents = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
            wakeEvents = undefined
            continue
          }
          const nextRepositoryId = pendingEvents.shift()
          if (nextRepositoryId === undefined) continue
          await onChange(nextRepositoryId)
        }
      },
    })

    await connectedPromise
    const fetchesAfterConnect = countFetches
    blockCountFetches = true
    pendingEvents.push(repositoryId, repositoryId)
    wakeEvents?.()
    await waitFor(() => countFetches === fetchesAfterConnect + 1)
    await waitFor(() => pendingEvents.length === 0)

    controller.abort()
    blockCountFetches = false
    releaseCountFetch?.()
    await live
    await Bun.sleep(20)
    expect(countFetches).toBe(fetchesAfterConnect + 1)
    stopObserving()
  })

  test("visibility refresh keeps retrying after failure", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let countFetches = 0
    let remainingFailures = 0
    const todayKey = [
      ...committedPullRequestsCountQueryKeyPrefix,
      "from",
      "to",
    ] as const
    const countQuery = {
      queryKey: todayKey,
      queryFn: async () => {
        countFetches += 1
        if (remainingFailures > 0) {
          remainingFailures -= 1
          throw new Error("count refresh failed")
        }
        return countFetches
      },
    }
    const stopObserving = observeQuery(queryClient, countQuery)
    await queryClient.fetchQuery(countQuery)

    let visibilityState: DocumentVisibilityState = "hidden"
    const listeners = new Map<string, Set<EventListener>>()
    const documentRef = {
      get visibilityState() {
        return visibilityState
      },
      addEventListener(type: string, listener: EventListener) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener)
      },
    }

    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: (id: string) => ({
          queryKey: ["work-items", id],
          queryFn: async () => [],
        }),
      },
      signal: controller.signal,
      documentRef,
      retryDelayMs: 15,
      stream: async ({ onConnected, signal }) => {
        await onConnected()
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await Bun.sleep(10)
    const afterConnect = countFetches
    remainingFailures = 2
    visibilityState = "visible"
    for (const listener of listeners.get("visibilitychange") ?? []) {
      listener(new Event("visibilitychange"))
    }
    await waitFor(() => countFetches >= afterConnect + 3)
    expect(queryClient.getQueryData(todayKey)).toBeGreaterThanOrEqual(
      afterConnect + 3,
    )

    controller.abort()
    await live
    stopObserving()
  })

  test("a failed count refresh still drains a pending notification", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let countFetches = 0
    let failNextCountFetch = false
    let blockCountFetches = false
    let releaseCountFetch: (() => void) | undefined
    const todayKey = [
      ...committedPullRequestsCountQueryKeyPrefix,
      "from",
      "to",
    ] as const
    const countQuery = {
      queryKey: todayKey,
      queryFn: async () => {
        countFetches += 1
        if (blockCountFetches) {
          await new Promise<void>((resolve) => {
            releaseCountFetch = resolve
          })
        }
        if (failNextCountFetch) {
          failNextCountFetch = false
          throw new Error("count refresh failed")
        }
        return countFetches
      },
    }
    const stopObserving = observeQuery(queryClient, countQuery)
    await queryClient.fetchQuery(countQuery)

    const pendingEvents: string[] = []
    let wakeEvents: (() => void) | undefined
    let connected: (() => void) | undefined
    const connectedPromise = new Promise<void>((resolve) => {
      connected = resolve
    })
    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: (id: string) => ({
          queryKey: ["work-items", id] as const,
          queryFn: async () => [],
        }),
      },
      signal: controller.signal,
      stream: async ({ onConnected, onChange, signal }) => {
        await onConnected()
        connected?.()
        while (!signal.aborted) {
          if (pendingEvents.length === 0) {
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              wakeEvents = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
            wakeEvents = undefined
            continue
          }
          const nextRepositoryId = pendingEvents.shift()
          if (nextRepositoryId === undefined) continue
          await onChange(nextRepositoryId)
        }
      },
    })

    await connectedPromise
    const fetchesAfterConnect = countFetches

    failNextCountFetch = true
    blockCountFetches = true
    pendingEvents.push(repositoryId)
    wakeEvents?.()
    await waitFor(() => countFetches === fetchesAfterConnect + 1)
    await waitFor(() => pendingEvents.length === 0)

    // Second event arrives while the failing pass is still in flight.
    pendingEvents.push(repositoryId)
    wakeEvents?.()
    await waitFor(() => pendingEvents.length === 0)

    blockCountFetches = false
    releaseCountFetch?.()
    // Failed pass must not drop the pending notification's trailing refresh.
    await waitFor(() => countFetches === fetchesAfterConnect + 2)
    expect(queryClient.getQueryData(todayKey)).toBe(fetchesAfterConnect + 2)

    controller.abort()
    await live
    stopObserving()
  })

  test("abort cancels in-flight Work Item refreshes", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let workItemFetches = 0
    let releaseWorkItemFetch: (() => void) | undefined
    const workItemsQuery = {
      queryKey: ["work-items", repositoryId] as const,
      queryFn: async () => {
        workItemFetches += 1
        if (workItemFetches >= 2) {
          await new Promise<void>((resolve) => {
            releaseWorkItemFetch = resolve
          })
        }
        return [{ id: `wi-${workItemFetches}` }]
      },
    }

    let onChange: ((repositoryId: string) => void | Promise<void>) | undefined
    let connected: (() => void) | undefined
    const connectedPromise = new Promise<void>((resolve) => {
      connected = resolve
    })
    const controller = new AbortController()
    const live = followRepositoryWorkItemsLive({
      getRepositoryIds: () => [repositoryId],
      queryClient,
      queries: {
        workItems: () => workItemsQuery,
      },
      signal: controller.signal,
      stream: async ({ onConnected, onChange: handleChange, signal }) => {
        onChange = handleChange
        await onConnected()
        connected?.()
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })

    await connectedPromise
    const fetchesAfterConnect = workItemFetches
    expect(fetchesAfterConnect).toBeGreaterThan(0)

    const inFlight = onChange?.(repositoryId)
    await waitFor(() => workItemFetches === fetchesAfterConnect + 1)
    expect(releaseWorkItemFetch).toBeDefined()

    controller.abort()
    await live
    releaseWorkItemFetch?.()
    await inFlight?.catch(() => undefined)
    await Bun.sleep(20)

    expect(workItemFetches).toBe(fetchesAfterConnect + 1)
    expect(queryClient.getQueryData(workItemsQuery.queryKey)).toEqual([
      { id: `wi-${fetchesAfterConnect}` },
    ])
  })
})
