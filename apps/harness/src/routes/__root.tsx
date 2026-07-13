import type { QueryClient } from "@tanstack/react-query"
import { ReactQueryDevtools } from "@tanstack/react-query-devtools"
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router"
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools"
import type { ReactNode } from "react"
import appCss from "../styles.css?url"

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1.0",
      },
      { title: "Ready for Agent" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
  notFoundComponent: () => (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p>Page not found.</p>
      <Link to="/">Back home</Link>
    </div>
  ),
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen min-w-80 bg-slate-50 font-sans text-slate-900 antialiased [font-synthesis:none] [text-rendering:optimizeLegibility]">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function RootComponent() {
  return (
    <div className="mx-auto min-h-screen max-w-6xl p-4 sm:p-6">
      <nav className="mb-6 flex gap-4 border-b border-slate-200 pb-4">
        <Link
          to="/"
          className="font-medium text-slate-700 hover:underline"
          activeProps={{ className: "font-bold text-slate-900" }}
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
