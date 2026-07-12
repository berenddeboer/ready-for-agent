import type { QueryClient } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import {
  Link,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools"

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: () => (
    <div className="card">
      <p>Page not found.</p>
      <Link to="/">Back home</Link>
    </div>
  ),
})

function RootComponent() {
  return (
    <div className="shell">
      <nav className="nav">
        <Link
          to="/"
          activeProps={{ className: "active" }}
          activeOptions={{ exact: true }}
        >
          Home
        </Link>
      </nav>
      <Outlet />
      <ReactQueryDevtools buttonPosition="bottom-left" />
      <TanStackRouterDevtools position="bottom-right" />
    </div>
  )
}
