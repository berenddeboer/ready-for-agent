/**
 * Shared chrome + card grid for the Completed surface (`/completed`).
 *
 * Primary Jobs switcher (Pipeline | Repos | Completed) lives in sticky root
 * chrome — this surface only keeps the card body.
 */
import { useNavigate } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { CompletedWorkItemRow } from "./completed-work-item-row.js"
import type { Repository, WorkItem } from "./home-page-content.js"
import { openSessionTelemetry } from "./session-telemetry-nav.js"
import { ui } from "./ui.js"

export type CompletedIssueLookup = {
  readonly title: string
  readonly url: string
}

export function repositoryIssueKey(
  repositoryId: string,
  issueNumber: number,
): string {
  return `${repositoryId}:${issueNumber}`
}

/**
 * Completed page body slot. Switcher lives in sticky root chrome
 * (JobsViewSwitcher). Repository filters are Pipeline-only until the archive
 * API supports server-side filtering.
 */
export function CompletedSurface({
  children,
}: {
  readonly children: ReactNode
}) {
  return <main className={ui.industrialShell}>{children}</main>
}

/**
 * Compact archive-style cards (journey legs, PR badge) in a responsive grid.
 */
export function CompletedCardGrid({
  items,
  repositoryById,
  issueByRepoAndNumber,
  emptyMessage,
  ariaLabel,
}: {
  readonly items: readonly WorkItem[]
  readonly repositoryById: ReadonlyMap<string, Repository>
  readonly issueByRepoAndNumber: ReadonlyMap<string, CompletedIssueLookup>
  readonly emptyMessage: string
  readonly ariaLabel: string
}) {
  // Session Telemetry is route-owned at root (`/session/<work-item-id>/telemetry`).
  const navigate = useNavigate()
  const onOpenSession = (workItemId: string, sessionId: string) => {
    void openSessionTelemetry({
      navigate,
      workItemId,
      sessionId,
    })
  }

  if (items.length === 0) {
    return (
      <p className={ui.pipelineListEmpty} role="status">
        {emptyMessage}
      </p>
    )
  }

  return (
    <ul className={ui.completedCardGrid} aria-label={ariaLabel}>
      {items.map((workItem) => (
        <CompletedWorkItemRow
          key={workItem.id}
          workItem={workItem}
          repository={repositoryById.get(workItem.repositoryId)}
          issue={issueByRepoAndNumber.get(
            repositoryIssueKey(workItem.repositoryId, workItem.issueNumber),
          )}
          onOpenSession={onOpenSession}
        />
      ))}
    </ul>
  )
}
