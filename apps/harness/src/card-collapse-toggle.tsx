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
      className="icon-btn"
      aria-expanded={!collapsed}
      aria-controls={controlsId}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      onClick={onToggle}
    >
      <svg
        aria-hidden="true"
        className={`transition-transform ${collapsed ? "" : "rotate-180"}`}
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
