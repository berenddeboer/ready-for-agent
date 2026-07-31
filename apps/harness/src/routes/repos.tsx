import { createFileRoute } from "@tanstack/react-router"
import { Suspense } from "react"
import { RepositoryCards, RepositoryCardsSkeleton } from "./index.js"

export const Route = createFileRoute("/repos")({
  component: ReposPage,
})

function ReposPage() {
  // Reading-width cap lives on the page body only — root chrome stays full-width.
  return (
    <main className="mx-auto max-w-[88rem] pt-8 sm:pt-10">
      <Suspense fallback={<RepositoryCardsSkeleton />}>
        <RepositoryCards />
      </Suspense>
    </main>
  )
}
