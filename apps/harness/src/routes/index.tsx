import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/")({
  component: HomePage,
})

function HomePage() {
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return {
        status: "ok",
        message: "Harness SPA is ready. GraphQL comes next.",
      }
    },
  })

  return (
    <div className="card">
      <h1>Ready for Agent</h1>
      <p className="muted">TanStack Router + Query SPA harness (no SSR).</p>
      {healthQuery.isPending ? (
        <p>Loading…</p>
      ) : healthQuery.isError ? (
        <p>Failed to load status.</p>
      ) : (
        <p>
          <strong>{healthQuery.data.status}</strong> —{" "}
          {healthQuery.data.message}
        </p>
      )}
    </div>
  )
}
