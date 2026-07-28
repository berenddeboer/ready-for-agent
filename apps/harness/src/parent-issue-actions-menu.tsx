import { type MouseEvent, type ReactNode, useEffect, useState } from "react"

export type ParentIssueActionsMenuProps = {
  readonly parentGithubIssueNumber: number
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
  parentGithubIssueNumber,
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

  return (
    <span className="relative" data-parent-issue-menu={menuId}>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center border border-rule-2 bg-panel text-ink-soft hover:border-ink-soft hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood"
        aria-label={`Actions for parent issue #${parentGithubIssueNumber}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={pending}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          // Keep parent <details> summary from toggling when opening the kebab.
          event.stopPropagation()
          setMenuOpen((open) => !open)
        }}
      >
        <svg
          aria-hidden="true"
          className="size-4"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
      </button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute top-full right-0 z-10 mt-1 min-w-56 border border-rule-2 bg-panel py-1 font-sans normal-case tracking-normal shadow-[0_12px_30px_rgb(28_22_14_/_18%)]"
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-2 text-left text-sm font-medium text-ink-2 hover:bg-paper-2"
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
      {errorMessage !== null && (
        <p
          className="absolute top-full right-0 z-10 mt-1 w-56 border border-rule-2 bg-panel px-2 py-1.5 font-sans text-xs font-normal text-oxblood-deep normal-case tracking-normal"
          role="alert"
        >
          {errorMessage}
        </p>
      )}
    </span>
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
  readonly openChildren: readonly {
    readonly githubIssueNumber: number
    readonly hasChildren: boolean
    readonly blockedBy: readonly unknown[]
  }[]
  /**
   * All direct children of the Parent (open and closed). Hierarchy rejection
   * uses this full set so a closed intermediate child still hides the action.
   */
  readonly directChildren: readonly {
    readonly hasChildren: boolean
  }[]
  readonly workItems: readonly {
    readonly githubIssueNumber: number
    readonly state: string
  }[]
  readonly workItemsLoading: boolean
}): boolean {
  if (input.workItemsLoading) return false
  if (input.openChildren.length === 0) return false
  // Match server: any direct child with children is unsupported hierarchy.
  if (input.directChildren.some((child) => child.hasChildren)) return false
  return true
}
