/**
 * Sticky Jobs primary switcher (Pipeline | Repos | Completed) and repository
 * filters — fixed under throughput.
 *
 * Links are a navigation list (not ARIA tabs): destinations are routes, so
 * every control stays in tab order. Repository filters only apply on Pipeline
 * (in-memory board); Repos and Completed hide them until server-side filter
 * support exists for the archive.
 */
import { Link, useRouterState } from "@tanstack/react-router"
import { JobsRepositoryFilters } from "./jobs-repository-filter.js"
import { isPipelineBackgroundPath } from "./routed-dialog.js"
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

export function JobsViewSwitcher() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const onCompleted =
    pathname === "/completed" || pathname.startsWith("/completed/")
  // `/settings` uses Pipeline as its canonical background (issue #840).
  const pipelineActive = isPipelineBackgroundPath(pathname)
  const reposActive = pathname === "/repos" || pathname.startsWith("/repos/")
  // Filters only drive the Pipeline board today (full in-memory item set).
  const showRepositoryFilters = pipelineActive

  return (
    <div className={ui.jobsSwitcherBand}>
      <div className={ui.jobsSwitcherRow}>
        <nav
          className={cx(ui.pipelineTabs, ui.jobsSwitcherPipelineTabs)}
          aria-label="Jobs"
        >
          <Link
            to="/"
            id="jobs-tab-pipeline"
            className={ui.pipelineTab}
            activeOptions={{ exact: true }}
            aria-current={pipelineActive ? "page" : undefined}
          >
            <PipelineTabIcon />
            Pipeline
          </Link>
          <Link
            to="/repos"
            id="jobs-tab-repos"
            className={ui.pipelineTab}
            aria-current={reposActive ? "page" : undefined}
          >
            <ReposTabIcon />
            Repos
          </Link>
          <Link
            to="/completed"
            id="jobs-tab-completed"
            className={ui.pipelineTab}
            aria-current={onCompleted ? "page" : undefined}
          >
            <CompletedTabIcon />
            Completed
          </Link>
        </nav>
        {showRepositoryFilters ? (
          <JobsRepositoryFilters className={ui.jobsSwitcherRepositoryFilters} />
        ) : null}
      </div>
    </div>
  )
}
