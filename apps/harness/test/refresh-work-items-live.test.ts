import { QueryClient } from "@tanstack/react-query"
import { followRepositoryWorkItemsLive } from "../src/refresh-work-items-live.js"
import { describe, expect, test } from "bun:test"

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
})
