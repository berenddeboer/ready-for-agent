import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localCommittedPullRequestDayBounds } from "../src/local-day-bounds.ts"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

describe("localCommittedPullRequestDayBounds", () => {
  test("uses local calendar day start/end as ISO instants", () => {
    const now = new Date(2026, 6, 18, 15, 30, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(now)
    const todayStart = new Date(2026, 6, 18, 0, 0, 0, 0)
    const tomorrowStart = new Date(2026, 6, 19, 0, 0, 0, 0)
    const yesterdayStart = new Date(2026, 6, 17, 0, 0, 0, 0)
    expect(bounds.todayFrom).toBe(todayStart.toISOString())
    expect(bounds.todayTo).toBe(tomorrowStart.toISOString())
    expect(bounds.yesterdayFrom).toBe(yesterdayStart.toISOString())
    expect(bounds.yesterdayTo).toBe(todayStart.toISOString())
  })

  test("handles month and year transitions", () => {
    const newYear = new Date(2026, 0, 1, 9, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(newYear)
    expect(bounds.yesterdayFrom).toBe(
      new Date(2025, 11, 31, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.yesterdayTo).toBe(
      new Date(2026, 0, 1, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.todayTo).toBe(new Date(2026, 0, 2, 0, 0, 0, 0).toISOString())
  })
})

describe("Committed pull requests dashboard UI", () => {
  test("renders above the Jobs card with Today and Yesterday labels", () => {
    const source = homeSource()
    const dashboardIndex = source.indexOf(
      'aria-label="Committed pull requests"',
    )
    const jobsIndex = source.indexOf('aria-label="Jobs"')
    expect(dashboardIndex).toBeGreaterThan(-1)
    expect(jobsIndex).toBeGreaterThan(dashboardIndex)
    expect(source).toContain("Today")
    expect(source).toContain("Yesterday")
    expect(source).toContain("function CommittedPullRequestsDashboard()")
  })

  test("loads counts via dedicated aggregate query with local day bounds", () => {
    const source = homeSource()
    expect(source).toContain("committedPullRequestsCount")
    expect(source).toContain("localCommittedPullRequestDayBounds")
    expect(source).toContain('queryKey: ["committed-pull-requests-count"')
    const dashboard = source.slice(
      source.indexOf("function CommittedPullRequestsDashboard()"),
      source.indexOf("function RepositoryCards()"),
    )
    expect(dashboard).not.toContain("workItems")
    expect(dashboard).not.toContain("JOBS_COMPLETED_LIMIT")
  })

  test("shows loading and error states without blocking Jobs", () => {
    const source = homeSource()
    expect(source).toContain('aria-label="Loading committed pull requests"')
    expect(source).toContain('role="status"')
    expect(source).toContain('aria-busy="true"')
    expect(source).toContain(
      "Could not load committed pull requests. Please try again.",
    )
    expect(source).toContain('role="alert"')
    const homePage = source.slice(
      source.indexOf("function HomePage()"),
      source.indexOf("function CommittedPullRequestsDashboard()"),
    )
    expect(homePage).toContain("<CommittedPullRequestsDashboard />")
    expect(homePage).toContain("<JobsCard />")
    expect(homePage).not.toContain("Suspense fallback={<Committed")
  })

  test("displays zero counts rather than hiding the dashboard", () => {
    const source = homeSource()
    const dashboard = source.slice(
      source.indexOf("function CommittedPullRequestsDashboard()"),
      source.indexOf("function RepositoryCards()"),
    )
    expect(dashboard).toContain("todayQuery.data ?? 0")
    expect(dashboard).toContain("yesterdayQuery.data ?? 0")
    expect(dashboard).toContain("{today}")
    expect(dashboard).toContain("{yesterday}")
  })
})
