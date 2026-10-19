import { sessionOpenAction } from "./session-open-action.js"
import { cx, ui } from "./ui.js"

/**
 * Opens the captured OpenCode session in a new tab. The href is a normal
 * browser URL; authentication is the existing OpenCode cookie, not a token
 * embedded in the link.
 */
export function OpenInOpenCodeLink({
  href,
  className,
}: {
  readonly href: string
  readonly className?: string
}) {
  return (
    <a
      className={cx(className)}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      Open in OpenCode
    </a>
  )
}

/** Card/row session action. Renders nothing when no OpenCode URL is available. */
export function OpenInOpenCodeSessionLink({
  url,
}: {
  readonly url: string | null | undefined
}) {
  const action = sessionOpenAction({ openInOpenCodeUrl: url })
  if (action.kind !== "open-in-opencode") return null
  return (
    <OpenInOpenCodeLink
      href={action.url}
      className={cx(ui.jobTicketSession, "shrink-0")}
    />
  )
}
