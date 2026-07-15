import { QueryClient } from "@tanstack/react-query"
import { followRepositoryIssuesLive } from "../src/refresh-issues-live.js"
import { describe, expect, test } from "bun:test"

describe("Repository Issue live-query coordination", () => {
  test("an invalidation refetches only the affected Repository Issues and metadata", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const otherRepositoryId = "repo-01JOTHER0000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    let repositoriesFetches = 0
    let selectedIssuesFetches = 0
    let otherIssuesFetches = 0
    let selectedWorkItemsFetches = 0
    let otherWorkItemsFetches = 0
    let issuesReconciledAt: string | null = null
    let selectedIssues = [
      {
        id: "issue-before",
        title: "Before refresh",
      },
    ]

    const queries = {
      repositories: {
        queryKey: ["repositories"] as const,
        queryFn: async () => {
          repositoriesFetches += 1
          return [
            {
              id: repositoryId,
              issuesReconciledAt,
            },
          ]
        },
      },
      issues: (id: string) => ({
        queryKey: ["issues", id] as const,
        queryFn: async () => {
          if (id === repositoryId) {
            selectedIssuesFetches += 1
            return selectedIssues
          }
          otherIssuesFetches += 1
          return []
        },
      }),
      workItems: (id: string) => ({
        queryKey: ["work-items", id] as const,
        queryFn: async () => {
          if (id === repositoryId) {
            selectedWorkItemsFetches += 1
            return []
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
    const live = followRepositoryIssuesLive({
      repositoryIds: [repositoryId, otherRepositoryId],
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

    issuesReconciledAt = "2026-07-14T12:00:00.000Z"
    selectedIssues = [
      {
        id: "issue-after",
        title: "After refresh",
      },
    ]
    const fetchesBeforeInvalidation = {
      repositories: repositoriesFetches,
      selectedIssues: selectedIssuesFetches,
      selectedWorkItems: selectedWorkItemsFetches,
    }
    releaseInvalidation?.()

    await Bun.sleep(20)

    const repositories = queryClient.getQueryData(queries.repositories.queryKey)
    const issues = queryClient.getQueryData(
      queries.issues(repositoryId).queryKey,
    )

    expect(repositories).toEqual([
      {
        id: repositoryId,
        issuesReconciledAt: "2026-07-14T12:00:00.000Z",
      },
    ])
    expect(issues).toEqual([
      {
        id: "issue-after",
        title: "After refresh",
      },
    ])
    expect(repositoriesFetches).toBeGreaterThan(
      fetchesBeforeInvalidation.repositories,
    )
    expect(selectedIssuesFetches).toBeGreaterThan(
      fetchesBeforeInvalidation.selectedIssues,
    )
    expect(selectedWorkItemsFetches).toBeGreaterThan(
      fetchesBeforeInvalidation.selectedWorkItems,
    )
    // Initial connection refetches both displayed Repositories, but the
    // selected invalidation does not refetch the other Repository again.
    expect(otherIssuesFetches).toBe(1)
    expect(otherWorkItemsFetches).toBe(1)
    const selectedFetchesBeforeOtherInvalidation = selectedIssuesFetches
    const selectedWorkItemsBeforeOtherInvalidation = selectedWorkItemsFetches
    const otherFetchesBeforeOtherInvalidation = otherIssuesFetches
    const otherWorkItemsBeforeOtherInvalidation = otherWorkItemsFetches
    await onChange?.(otherRepositoryId)
    expect(selectedIssuesFetches).toBe(selectedFetchesBeforeOtherInvalidation)
    expect(selectedWorkItemsFetches).toBe(
      selectedWorkItemsBeforeOtherInvalidation,
    )
    expect(otherIssuesFetches).toBeGreaterThan(
      otherFetchesBeforeOtherInvalidation,
    )
    expect(otherWorkItemsFetches).toBeGreaterThan(
      otherWorkItemsBeforeOtherInvalidation,
    )
    expect(onChange).toBeDefined()

    controller.abort()
    await live
  })

  test("an invalidation replaces a stale in-flight Issue fetch", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let resolveStale:
      | ((issues: readonly { title: string }[]) => void)
      | undefined
    const staleResponse = new Promise<readonly { title: string }[]>(
      (resolve) => {
        resolveStale = resolve
      },
    )
    let issueFetches = 0
    const issuesQuery = {
      queryKey: ["issues", repositoryId] as const,
      queryFn: async () => {
        issueFetches += 1
        if (issueFetches === 1) return staleResponse
        return [{ title: "After reconciliation" }]
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
    const live = followRepositoryIssuesLive({
      repositoryIds: [repositoryId],
      queryClient,
      queries: {
        repositories: {
          queryKey: ["repositories"],
          queryFn: async () => [{ id: repositoryId }],
        },
        issues: () => issuesQuery,
        workItems: (id) => ({
          queryKey: ["work-items", id],
          queryFn: async () => [],
        }),
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
    const staleFetch = queryClient.fetchQuery({ ...issuesQuery, staleTime: 0 })
    await Bun.sleep(0)
    expect(issueFetches).toBe(1)

    await onChange?.(repositoryId)
    expect(issueFetches).toBe(2)
    expect(queryClient.getQueryData(issuesQuery.queryKey)).toEqual([
      { title: "After reconciliation" },
    ])

    resolveStale?.([{ title: "Before reconciliation" }])
    await staleFetch.catch(() => undefined)
    expect(queryClient.getQueryData(issuesQuery.queryKey)).toEqual([
      { title: "After reconciliation" },
    ])

    controller.abort()
    await live
  })

  test("tab visibility refetch is a fallback for missed invalidations", async () => {
    const repositoryId = "repo-01JSELECTED000000000000000"
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let repositoriesFetches = 0
    let issuesFetches = 0
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
    const live = followRepositoryIssuesLive({
      repositoryIds: [repositoryId],
      queryClient,
      queries: {
        repositories: {
          queryKey: ["repositories"],
          queryFn: async () => {
            repositoriesFetches += 1
            return [{ id: repositoryId, issuesReconciledAt: "t1" }]
          },
        },
        issues: (id: string) => ({
          queryKey: ["issues", id],
          queryFn: async () => {
            if (id === repositoryId) issuesFetches += 1
            return []
          },
        }),
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
    const repositoriesAfterConnect = repositoriesFetches
    const issuesAfterConnect = issuesFetches
    expect(repositoriesAfterConnect).toBeGreaterThan(0)
    expect(issuesAfterConnect).toBeGreaterThan(0)

    visibilityState = "visible"
    for (const listener of listeners.get("visibilitychange") ?? []) {
      listener(new Event("visibilitychange"))
    }
    await Bun.sleep(10)

    expect(repositoriesFetches).toBeGreaterThan(repositoriesAfterConnect)
    expect(issuesFetches).toBeGreaterThan(issuesAfterConnect)

    controller.abort()
    await live
    expect(listeners.get("visibilitychange")?.size ?? 0).toBe(0)
  })
})
