import { type MouseEvent, type ReactNode, useEffect, useState } from "react"
import { evaluateLeafIssue } from "@ready-for-agent/lifecycle-model"
import { Banner } from "./banner.js"
import { cx, ui } from "./ui.js"

export type ParentIssueActionsMenuProps = {
  readonly parentIssueNumber: number
  readonly menuId: string
  readonly pending: boolean
  readonly errorMessage: string | null
  readonly onImplementAllWithAutoMerge: () => void
}

/**
 * Parent Issue kebab with the sole action Implement all with auto-merge.
 * Presentational shell so accessibility and menu interaction can be tested
 * without the full Issues list.
 */
export function ParentIssueActionsMenu({
  parentIssueNumber,
  menuId,
  pending,
  errorMessage,
  onImplementAllWithAutoMerge,
}: ParentIssueActionsMenuProps): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(`[data-parent-issue-menu="${menuId}"]`)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [menuId, menuOpen])

  // Kebab only — parent-group failures are rendered in-flow under the summary
  // (see ParentIssueGroup). errorMessage remains for isolated unit tests of
  // the presentational shell.
  return (
    <>
      <span className="relative" data-parent-issue-menu={menuId}>
        <button
          type="button"
          className={ui.iconBtn}
          aria-label={`Actions for parent issue #${parentIssueNumber}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={pending}
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            // Keep parent <details> summary from toggling when opening the kebab.
            event.stopPropagation()
            setMenuOpen((open) => !open)
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="1.75" />
            <circle cx="12" cy="12" r="1.75" />
            <circle cx="12" cy="19" r="1.75" />
          </svg>
        </button>
        {menuOpen && (
          <div role="menu" className={cx(ui.menuPanel, "min-w-56")}>
            <button
              type="button"
              role="menuitem"
              className={ui.menuItem}
              disabled={pending}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation()
                setMenuOpen(false)
                onImplementAllWithAutoMerge()
              }}
            >
              {pending ? "Starting..." : "Implement all with auto-merge"}
            </button>
          </div>
        )}
      </span>
      {errorMessage !== null && (
        <Banner
          className={cx(ui.bannerCompact, ui.parentIssueError)}
          tone="alarm"
          tag="Error"
          role="alert"
        >
          {errorMessage}
        </Banner>
      )}
    </>
  )
}

/**
 * Eligibility: Parent with one or more open leaf Child Issues under a Supported
 * Issue Hierarchy. Available even when open children already have unfinished
 * Work Items (the command adopts them and sets Merge Mode Always). Unsupported
 * hierarchy shapes (any direct child with children, including closed mid-level
 * Issues) hide the action, matching the server check. Work Item rows are not
 * required for eligibility once loading finishes — repeated invocation is safe.
 */
export function isParentImplementAllWithAutoMergeEligible(input: {
  readonly openChildren: readonly unknown[]
  /**
   * All direct children of the Parent (open and closed). Hierarchy rejection
   * uses this full set so a closed intermediate child still hides the action.
   */
  readonly directChildren: readonly {
    readonly hasChildren: boolean
  }[]
  readonly workItemsLoading: boolean
}): boolean {
  if (input.workItemsLoading) return false
  if (input.openChildren.length === 0) return false
  if (
    input.directChildren.some(
      (child) => evaluateLeafIssue(child)._tag !== "match",
    )
  ) {
    return false
  }
  return true
}
