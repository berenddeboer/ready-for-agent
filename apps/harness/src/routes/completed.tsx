import { useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Suspense, useEffect, useState } from "react"
import { Banner, BannerActionButton } from "../banner.js"
import {
  CompletedCardGrid,
  CompletedSurface,
  repositoryIssueKey,
} from "../completed-surface.js"
import {
  COMPLETED_WORK_ITEMS_PAGE_SIZE,
  completedWorkItemsHistoryQuery,
  issuesQuery,
  repositoriesQuery,
} from "../home-page-content.js"
import { ui } from "../ui.js"
import { WorkItemsLiveUpdates } from "../work-items-live-updates.js"

/**
 * Full completed-work archive (server-paginated). Sticky Jobs chrome links here.
 */
export const Route = createFileRoute("/completed")({
  component: CompletedPage,
})

function CompletedPage() {
  return (
    <Suspense
      fallback={
        <main className={ui.industrialShell}>
          <p className={ui.pipelineListEmpty} role="status">
            Loading completed work items…
          </p>
        </main>
      }
    >
      <CompletedBoard />
    </Suspense>
  )
}

function CompletedBoard() {
  const [page, setPage] = useState(1)
  const { data: repositories } = useSuspenseQuery(repositoriesQuery)
  const repositoryIds = repositories.map(({ id }) => id)
  const completedQuery = useQuery(completedWorkItemsHistoryQuery(page))
  const issueQueries = useQueries({
    queries: repositories.map((repository) => issuesQuery(repository.id)),
  })

  const repositoryById = new Map(
    repositories.map((repository) => [repository.id, repository] as const),
  )
  const issueByRepoAndNumber = new Map<
    string,
    { readonly title: string; readonly url: string }
  >()
  for (const query of issueQueries) {
    for (const issue of query.data ?? []) {
      issueByRepoAndNumber.set(
        repositoryIssueKey(issue.repositoryId, issue.issueNumber),
        { title: issue.title, url: issue.url },
      )
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
        <main className={ui.industrialShell}>
          <p className={ui.pipelineListEmpty} role="status">
            Loading completed work items…
          </p>
        </main>
      </>
    )
  }

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
        <main className={ui.industrialShell}>
          <p className={ui.pipelineListEmpty} role="status">
            Loading completed work items…
          </p>
        </main>
      </>
    )
  }

  // Server-paginated archive — no client-side repository filter (would only
  // filter the current page and desync totals/pager). Filter chrome is hidden
  // on this route until completedWorkItems accepts repositoryId.
  const items = pageData.items
  const hasPreviousPage = pageData.hasPreviousPage
  const hasNextPage = pageData.hasNextPage
  const resolvedPageSize = pageData.pageSize
  const resolvedTotalCount = pageData.totalCount
  const resolvedTotalPages =
    resolvedTotalCount === 0
      ? 1
      : Math.max(1, Math.ceil(resolvedTotalCount / resolvedPageSize))
  const currentPage = Math.min(pageData.page, resolvedTotalPages)
  const rangeStart =
    pageData.items.length === 0 ? 0 : (currentPage - 1) * resolvedPageSize + 1
  const rangeEnd = (currentPage - 1) * resolvedPageSize + pageData.items.length
  const refreshFailedWithData =
    completedQuery.isError && completedQuery.data !== undefined

  const emptyMessage =
    resolvedTotalCount === 0
      ? "No completed work items yet"
      : "No completed work items on this page"

  return (
    <>
      {live}
      <CompletedSurface>
        {refreshFailedWithData ? (
          <Banner
            tone="alarm"
            tag="Refresh failed"
            className="mb-4"
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

        <CompletedCardGrid
          items={items}
          repositoryById={repositoryById}
          issueByRepoAndNumber={issueByRepoAndNumber}
          emptyMessage={emptyMessage}
          ariaLabel="All completed work items"
        />

        <nav className={ui.pager} aria-label="Completed work items pagination">
          <p className={ui.pagerNote} aria-live="polite">
            Page {currentPage} of {resolvedTotalPages}
            {resolvedTotalCount > 0 && pageData.items.length > 0
              ? ` · ${rangeStart}–${rangeEnd} of ${resolvedTotalCount}`
              : resolvedTotalCount > 0
                ? ` · ${resolvedTotalCount} total`
                : null}
            {resolvedPageSize !== COMPLETED_WORK_ITEMS_PAGE_SIZE
              ? ` · ${resolvedPageSize} per page`
              : null}
          </p>
          <div className={ui.pagerBtns}>
            <button
              type="button"
              className={ui.plateMini}
              disabled={!hasPreviousPage || completedQuery.isFetching}
              aria-busy={completedQuery.isFetching || undefined}
              aria-label="Previous page of completed work items"
              onClick={() => {
                setPage((current) => Math.max(1, current - 1))
              }}
            >
              ← Prev
            </button>
            <button
              type="button"
              className={ui.plateMini}
              disabled={!hasNextPage || completedQuery.isFetching}
              aria-busy={completedQuery.isFetching || undefined}
              aria-label="Next page of completed work items"
              onClick={() => {
                setPage((current) => current + 1)
              }}
            >
              Next →
            </button>
          </div>
        </nav>
      </CompletedSurface>
    </>
  )
}
