/**
 * `/repos/<repository-id>/settings` — browser-addressable Repository settings
 * overlay (issue #842).
 *
 * Nested under the Repos layout so the Repos background stays mounted. The
 * dialog itself is owned by RepositoryCards / RepositoryCard, driven by the
 * pathname; this route only registers the addressable location.
 */
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/repos/$repositoryId/settings")({
  component: RepositorySettingsRoutePlaceholder,
})

function RepositorySettingsRoutePlaceholder() {
  // Dialog visibility is synchronized from the URL in RepositoryCards.
  return null
}
