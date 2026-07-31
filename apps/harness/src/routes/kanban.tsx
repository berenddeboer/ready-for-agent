import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Bookmarks and deep links to `/kanban` land on the board at `/`.
 */
export const Route = createFileRoute("/kanban")({
  beforeLoad: () => {
    // Replace so Back does not re-enter the legacy path.
    throw redirect({ to: "/", replace: true })
  },
})
