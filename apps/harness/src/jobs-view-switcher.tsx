/**
 * Sticky Jobs primary switcher (Pipeline | Repos | Completed) and repository
 * filters — fixed under throughput.
 *
 * Links are a navigation list (not ARIA tabs): destinations are routes, so
 * every control stays in tab order. Repository filters only apply on Pipeline
 * (in-memory board); Repos and Completed hide them until server-side filter
 * support exists for the archive.
 */
import { useLinkProps, useRouterState } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { JobsRepositoryFilters } from "./jobs-repository-filter.js"
import { jobsViewForPath } from "./routed-dialog.js"
import { cx, ui } from "./ui.js"

function PipelineTabIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 6h4v12H4z" />
      <path d="M10 6h4v12h-4z" />
      <path d="M16 6h4v12h-4z" />
    </svg>
  )
}

function ReposTabIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 7.5c0-1.5 3.6-2.5 8-2.5s8 1 8 2.5v9c0 1.5-3.6 2.5-8 2.5s-8-1-8-2.5v-9Z" />
      <path d="M4 7.5c0 1.5 3.6 2.5 8 2.5s8-1 8-2.5" />
      <path d="M4 12c0 1.5 3.6 2.5 8 2.5s8-1 8-2.5" />
    </svg>
  )
}

function CompletedTabIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M20 6.5 9.5 17 4 11.5" />
    </svg>
  )
}

/**
 * Jobs destination link whose active attrs follow `jobsViewForPath`, not
 * TanStack's path+search isActive. Link would otherwise set aria-current and
 * data-status after our props, which can disagree on SSR/hydration when the
 * retained `theme` search pin is present (issue #1041).
 */
function JobsDestinationLink({
  to,
  id,
  current,
  exact = false,
  children,
}: {
  readonly to: "/" | "/repos" | "/completed"
  readonly id: string
  readonly current: boolean
  readonly exact?: boolean
  readonly children: ReactNode
}) {
  const props = useLinkProps({
    to,
    id,
    className: ui.pipelineTab,
    activeOptions: { exact, includeSearch: false },
  })
  return (
    <a
      {...props}
      aria-current={current ? "page" : undefined}
      data-status={current ? "active" : undefined}
    >
      {children}
    </a>
  )
}

export function JobsViewSwitcher() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Direct `/settings` and telemetry loads use Pipeline as their canonical
  // background. Masked Settings and telemetry opens retain the runtime origin
  // pathname, so the originating Jobs tab remains active
  // (issues #840–#843 / #906 / #1146).
  const jobsView = jobsViewForPath(pathname)
  const pipelineActive = jobsView === "pipeline"
  const reposActive = jobsView === "repos"
  const completedActive = jobsView === "completed"
  // Filters only drive the Pipeline board today (full in-memory item set).
  const showRepositoryFilters = pipelineActive

  return (
    <div className={ui.jobsSwitcherBand}>
      <div className={ui.jobsSwitcherRow}>
        <nav
          className={cx(ui.pipelineTabs, ui.jobsSwitcherPipelineTabs)}
          aria-label="Jobs"
        >
          <JobsDestinationLink
            to="/"
            id="jobs-tab-pipeline"
            exact
            current={pipelineActive}
          >
            <PipelineTabIcon />
            Pipeline
          </JobsDestinationLink>
          <JobsDestinationLink
            to="/repos"
            id="jobs-tab-repos"
            current={reposActive}
          >
            <ReposTabIcon />
            Repos
          </JobsDestinationLink>
          <JobsDestinationLink
            to="/completed"
            id="jobs-tab-completed"
            current={completedActive}
          >
            <CompletedTabIcon />
            Completed
          </JobsDestinationLink>
        </nav>
        {showRepositoryFilters ? (
          <JobsRepositoryFilters className={ui.jobsSwitcherRepositoryFilters} />
        ) : null}
      </div>
    </div>
  )
}
