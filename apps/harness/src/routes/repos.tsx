import { createFileRoute } from "@tanstack/react-router"
import { Suspense } from "react"
import { RepositoryCards, RepositoryCardsSkeleton } from "./index.js"

export const Route = createFileRoute("/repos")({
  component: ReposPage,
})

function ReposPage() {
  return (
    <main className="pt-8 sm:pt-10">
      <Suspense fallback={<RepositoryCardsSkeleton />}>
        <RepositoryCards />
      </Suspense>
    </main>
  )
}
