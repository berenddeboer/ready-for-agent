import { type ReactNode, useEffect, useState } from "react"
import { cx, ui } from "./ui.js"

export type IssueActionsMenuProps = {
  readonly issueNumber: number
  readonly issueId: string
  readonly canImplement: boolean
  readonly canQueue: boolean
  readonly implementPending: boolean
  readonly implementNowPending: boolean
  readonly implementLocallyPending: boolean
  readonly queuePending: boolean
  readonly onImplementNow: () => void
  readonly onImplementWith: () => void
  readonly onImplementLocally: () => void
  readonly onQueue: () => void
}

/**
 * Actionable Issue kebab: Implement now, Implement with..., Implement locally.
 * Blocked Issues show Queue only. Presentational so menu order and eligibility
 * can be tested without the Repos list.
 */
export function IssueActionsMenu({
  issueNumber,
  issueId,
  canImplement,
  canQueue,
  implementPending,
  implementNowPending,
  implementLocallyPending,
  queuePending,
  onImplementNow,
  onImplementWith,
  onImplementLocally,
  onQueue,
}: IssueActionsMenuProps): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(`[data-issue-menu="${issueId}"]`)) return
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
  }, [issueId, menuOpen])

  if (!canImplement && !canQueue) {
    return null
  }

  const runMenuAction = (action: () => void) => {
    setMenuOpen(false)
    action()
  }

  return (
    <span className="relative" data-issue-menu={issueId}>
      <button
        type="button"
        className={ui.iconBtn}
        aria-label={`Actions for issue #${issueNumber}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
      </button>
      {menuOpen && (
        <div role="menu" className={cx(ui.menuPanel, "min-w-44")}>
          {canImplement && (
            <>
              <button
                type="button"
                role="menuitem"
                className={ui.menuItem}
                disabled={implementPending}
                onClick={() => runMenuAction(onImplementNow)}
              >
                {implementNowPending ? "Starting..." : "Implement now"}
              </button>
              <button
                type="button"
                role="menuitem"
                className={ui.menuItem}
                disabled={implementPending}
                onClick={() => runMenuAction(onImplementWith)}
              >
                Implement with...
              </button>
              <button
                type="button"
                role="menuitem"
                className={ui.menuItem}
                disabled={implementPending}
                onClick={() => runMenuAction(onImplementLocally)}
              >
                {implementLocallyPending ? "Starting..." : "Implement locally"}
              </button>
            </>
          )}
          {canQueue && (
            <button
              type="button"
              role="menuitem"
              className={ui.menuItem}
              disabled={implementPending}
              onClick={() => runMenuAction(onQueue)}
            >
              {queuePending ? "Queueing..." : "Queue"}
            </button>
          )}
        </div>
      )}
    </span>
  )
}
