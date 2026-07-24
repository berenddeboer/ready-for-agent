type CardCollapseToggleProps = {
  collapsed: boolean
  onToggle: () => void
  controlsId: string
  label: string
}

/** Keyboard-accessible expand/collapse control for dashboard cards. */
export function CardCollapseToggle({
  collapsed,
  onToggle,
  controlsId,
  label,
}: CardCollapseToggleProps) {
  return (
    <button
      type="button"
      className="inline-flex size-8 shrink-0 items-center justify-center border border-rule-2 bg-panel text-ink-soft transition hover:border-ink-soft hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-oxblood"
      aria-expanded={!collapsed}
      aria-controls={controlsId}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      onClick={onToggle}
    >
      <svg
        aria-hidden="true"
        className={`size-4 transition-transform ${collapsed ? "" : "rotate-180"}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  )
}
