import { useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Suspense, useEffect, useState } from "react"
import { Banner, BannerActionButton } from "../banner.js"
import { CompletedWorkItemRow } from "../completed-work-item-row.js"
import { WorkItemsLiveUpdates } from "../work-items-live-updates.js"
import {
  COMPLETED_WORK_ITEMS_PAGE_SIZE,
  SessionUsageDialog,
  completedWorkItemsHistoryQuery,
  issuesQuery,
  repositoriesQuery,
} from "./index.js"

export const Route = createFileRoute("/completed")({
  component: CompletedPage,
})

function CompletedPage() {
  // Reading-width cap lives on the page body only — root chrome stays full-width.
  return (
    <main className="mx-auto max-w-[88rem] pt-8 sm:pt-10">
      <header className="mb-5">
        <p className="m-0 font-mono text-xs font-semibold tracking-[0.22em] text-oxblood uppercase">
          History
        </p>
        <h1 className="mt-1.5 font-serif text-[clamp(1.5rem,2.8vw,2rem)] font-semibold tracking-[-0.01em]">
          Completed work items
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          Historical Complete and Abandoned Work Items across every repository,
          newest first. The Kanban Completed tab still shows only the last
          rolling window; this page is the full archive.
        </p>
      </header>
      <Suspense fallback={<CompletedListSkeleton />}>
        <CompletedWorkItemsBoard />
      </Suspense>
    </main>
  )
}

function CompletedListSkeleton() {
  return (
    <article
      className="border border-rule-2 bg-panel px-4 py-3 sm:px-5"
      role="status"
      aria-label="Loading completed work items"
      aria-busy="true"
    >
      <div className="grid gap-2">
        <span className="block h-12 animate-pulse bg-paper-2 motion-reduce:animate-none" />
        <span className="block h-12 animate-pulse bg-paper-2 motion-reduce:animate-none" />
      </div>
    </article>
  )
}

function CompletedWorkItemsBoard() {
  const [page, setPage] = useState(1)
  const [sessionDialog, setSessionDialog] = useState<{
    workItemId: string
    sessionId: string
  } | null>(null)
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)
  const repositoryIds = repositories.map(({ id }) => id)
  const completedQuery = useQuery(completedWorkItemsHistoryQuery(page))
  const issueQueries = useQueries({
    queries: repositories.map((repository) => issuesQuery(repository.id)),
  })

  const repositoryById = new Map(
    repositories.map((repository) => [repository.id, repository] as const),
  )
  const issueByRepoAndNumber = new Map<string, { title: string; url: string }>()
  for (const query of issueQueries) {
    for (const issue of query.data ?? []) {
      issueByRepoAndNumber.set(`${issue.repositoryId}:${issue.issueNumber}`, {
        title: issue.title,
        url: issue.url,
      })
    }
  }

  const pageData = completedQuery.data
  const totalCount = pageData?.totalCount
  const pageSize = pageData?.pageSize
  const totalPages =
    totalCount === undefined || pageSize === undefined
      ? undefined
      : totalCount === 0
        ? 1
        : Math.max(1, Math.ceil(totalCount / pageSize))

  // When history shrinks under us (SSE refresh), clamp past the last page.
  useEffect(() => {
    if (totalPages === undefined) return
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  // Live updates must outlive pending/error UI. Unmounting on skeleton aborts
  // the follower and cancels the completed-work-items query prefix mid-fetch.
  const live = <WorkItemsLiveUpdates repositoryIds={repositoryIds} />

  if (completedQuery.isPending && completedQuery.data === undefined) {
    return (
      <>
        {live}
        <CompletedListSkeleton />
      </>
    )
  }

  // Hard error only when nothing is usable. Background refetch (SSE) can set
  // isError while keepPreviousData / prior success still has data.
  if (completedQuery.isError && completedQuery.data === undefined) {
    return (
      <>
        {live}
        <Banner
          tone="alarm"
          tag="Error"
          role="alert"
          action={
            <BannerActionButton
              onClick={() => {
                void completedQuery.refetch()
              }}
            >
              Retry
            </BannerActionButton>
          }
        >
          Could not load completed work items. Please try again.
        </Banner>
      </>
    )
  }

  if (pageData === undefined) {
    return (
      <>
        {live}
        <CompletedListSkeleton />
      </>
    )
  }

  const items = pageData.items
  const hasPreviousPage = pageData.hasPreviousPage
  const hasNextPage = pageData.hasNextPage
  const resolvedPageSize = pageData.pageSize
  const resolvedTotalCount = pageData.totalCount
  const resolvedTotalPages =
    resolvedTotalCount === 0
      ? 1
      : Math.max(1, Math.ceil(resolvedTotalCount / resolvedPageSize))
  // Prefer clamped display so "Page N of M" never flashes N > M before the
  // setPage effect commits (server may still return empty pages past the end).
  const currentPage = Math.min(pageData.page, resolvedTotalPages)
  const rangeStart =
    items.length === 0 ? 0 : (currentPage - 1) * resolvedPageSize + 1
  const rangeEnd = (currentPage - 1) * resolvedPageSize + items.length
  const refreshFailedWithData =
    completedQuery.isError && completedQuery.data !== undefined

  return (
    <article className="border border-rule-2 bg-panel px-4 py-3 sm:px-5">
      {live}
      {refreshFailedWithData ? (
        <Banner
          className="mb-3"
          tone="alarm"
          tag="Refresh failed"
          action={
            <BannerActionButton
              onClick={() => {
                void completedQuery.refetch()
              }}
            >
              Retry
            </BannerActionButton>
          }
        >
          Could not refresh completed work items. Showing last loaded page.
        </Banner>
      ) : null}
      {resolvedTotalCount === 0 ? (
        <p className="m-0 font-serif text-sm italic text-ink-soft">
          No completed work items yet.
        </p>
      ) : items.length === 0 ? (
        <p className="m-0 font-serif text-sm italic text-ink-soft">
          No completed work items on this page.
        </p>
      ) : (
        <ul
          className="m-0 grid min-w-0 list-none gap-1 p-0"
          aria-label="Completed work items"
        >
          {items.map((workItem) => (
            <CompletedWorkItemRow
              key={workItem.id}
              workItem={workItem}
              repository={repositoryById.get(workItem.repositoryId)}
              issue={issueByRepoAndNumber.get(
                `${workItem.repositoryId}:${workItem.issueNumber}`,
              )}
              onOpenSession={(workItemId, sessionId) => {
                setSessionDialog({ workItemId, sessionId })
              }}
            />
          ))}
        </ul>
      )}

      <nav
        className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3"
        aria-label="Completed work items pagination"
      >
        <p
          className="m-0 font-mono text-xs tracking-[0.08em] text-ink-faint uppercase"
          aria-live="polite"
        >
          Page {currentPage} of {resolvedTotalPages}
          {resolvedTotalCount > 0 && items.length > 0
            ? ` · ${rangeStart}–${rangeEnd} of ${resolvedTotalCount}`
            : resolvedTotalCount > 0
              ? ` · ${resolvedTotalCount} total`
              : null}
          {resolvedPageSize !== COMPLETED_WORK_ITEMS_PAGE_SIZE
            ? ` · ${resolvedPageSize} per page`
            : null}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="border border-rule-2 bg-paper px-3 py-1.5 text-sm font-semibold text-ink-2 transition hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!hasPreviousPage || completedQuery.isFetching}
            aria-label="Previous page of completed work items"
            onClick={() => {
              setPage((current) => Math.max(1, current - 1))
            }}
          >
            Previous
          </button>
          <button
            type="button"
            className="border border-rule-2 bg-paper px-3 py-1.5 text-sm font-semibold text-ink-2 transition hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!hasNextPage || completedQuery.isFetching}
            aria-label="Next page of completed work items"
            onClick={() => {
              setPage((current) => current + 1)
            }}
          >
            Next
          </button>
        </div>
      </nav>

      <SessionUsageDialog
        workItemId={sessionDialog?.workItemId ?? null}
        sessionId={sessionDialog?.sessionId ?? null}
        open={sessionDialog !== null}
        onClose={() => {
          setSessionDialog(null)
        }}
      />
    </article>
  )
}
