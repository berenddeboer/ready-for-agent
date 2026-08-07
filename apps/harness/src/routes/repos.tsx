import { Outlet, createFileRoute } from "@tanstack/react-router"
import { Suspense } from "react"
import {
  RepositoryCards,
  RepositoryCardsSkeleton,
} from "../home-page-content.js"

export const Route = createFileRoute("/repos")({
  component: ReposPage,
})

/**
 * Repos surface and layout parent for `/repos/$repositoryId/settings`
 * (issue #842). The overlay dialog is route-driven inside RepositoryCards;
 * child routes mount via Outlet so this page stays mounted across open/close.
 */
function ReposPage() {
  // Reading-width cap lives on the page body only — root chrome stays full-width.
  return (
    <main className="mx-auto max-w-[88rem] pt-8 sm:pt-10">
      <Suspense fallback={<RepositoryCardsSkeleton />}>
        <RepositoryCards />
      </Suspense>
      {/* Nested settings overlay route — dialog UI is path-driven above. */}
      <Outlet />
    </main>
  )
}
