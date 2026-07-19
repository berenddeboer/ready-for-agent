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
    const lastWeekStart = new Date(2026, 6, 11, 0, 0, 0, 0)
    expect(bounds.todayFrom).toBe(todayStart.toISOString())
    expect(bounds.todayTo).toBe(tomorrowStart.toISOString())
    expect(bounds.yesterdayFrom).toBe(yesterdayStart.toISOString())
    expect(bounds.yesterdayTo).toBe(todayStart.toISOString())
    expect(bounds.lastWeekFrom).toBe(lastWeekStart.toISOString())
    expect(bounds.lastWeekTo).toBe(todayStart.toISOString())
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
    expect(bounds.lastWeekFrom).toBe(
      new Date(2025, 11, 25, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekTo).toBe(
      new Date(2026, 0, 1, 0, 0, 0, 0).toISOString(),
    )
  })

  test("last week spans seven complete local days before today", () => {
    const now = new Date(2026, 2, 15, 12, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(now)
    const lastWeekFrom = new Date(bounds.lastWeekFrom)
    const lastWeekTo = new Date(bounds.lastWeekTo)
    const todayFrom = new Date(bounds.todayFrom)
    expect(lastWeekTo.getTime()).toBe(todayFrom.getTime())
    expect(bounds.yesterdayFrom >= bounds.lastWeekFrom).toBe(true)
    expect(bounds.yesterdayTo <= bounds.lastWeekTo).toBe(true)
    const msPerDay = 24 * 60 * 60 * 1000
    expect(
      (lastWeekTo.getTime() - lastWeekFrom.getTime()) / msPerDay,
    ).toBeCloseTo(7, 5)
  })

  test("handles spring-forward daylight-saving local midnight", () => {
    // US Pacific 2026: clocks spring forward 2026-03-08 02:00 → 03:00
    const afterSpringForward = new Date(2026, 2, 9, 10, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(afterSpringForward)
    expect(bounds.lastWeekFrom).toBe(
      new Date(2026, 2, 2, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekTo).toBe(
      new Date(2026, 2, 9, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.yesterdayFrom).toBe(
      new Date(2026, 2, 8, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.todayFrom).toBe(
      new Date(2026, 2, 9, 0, 0, 0, 0).toISOString(),
    )
  })

  test("handles fall-back daylight-saving local midnight", () => {
    // US Pacific 2026: clocks fall back 2026-11-01 02:00 → 01:00
    const afterFallBack = new Date(2026, 10, 2, 10, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(afterFallBack)
    expect(bounds.lastWeekFrom).toBe(
      new Date(2026, 9, 26, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekTo).toBe(
      new Date(2026, 10, 2, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.yesterdayFrom).toBe(
      new Date(2026, 10, 1, 0, 0, 0, 0).toISOString(),
    )
  })
})

describe("Committed pull requests dashboard UI", () => {
  test("renders above the Jobs card with Today, Yesterday, and Last week labels", () => {
    const source = homeSource()
    const dashboardIndex = source.indexOf(
      'aria-label="Committed pull requests"',
    )
    const jobsIndex = source.indexOf('aria-label="Jobs"')
    expect(dashboardIndex).toBeGreaterThan(-1)
    expect(jobsIndex).toBeGreaterThan(dashboardIndex)
    expect(source).toContain("Today")
    expect(source).toContain("Yesterday")
    expect(source).toContain("Last week")
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
    expect(dashboard).toContain("bounds.lastWeekFrom")
    expect(dashboard).toContain("bounds.lastWeekTo")
    expect(dashboard).not.toContain("workItems")
    expect(dashboard).not.toContain("JOBS_COMPLETED_LIMIT")
  })

  test("shows loading and error states without blocking Jobs", () => {
    const source = homeSource()
    expect(source).toContain('aria-label="Loading committed pull requests"')
    expect(source).toContain('role="status"')
    expect(source).toContain('aria-busy="true"')
    expect(source).toContain("grid-cols-3")
    expect(source).toContain(
      "Could not load committed pull requests. Please try again.",
    )
    expect(source).toContain('role="alert"')
    const homeBody = source.slice(
      source.indexOf("function HomeBody()"),
      source.indexOf("function CommittedPullRequestsDashboard()"),
    )
    expect(homeBody).toContain("<CommittedPullRequestsDashboard />")
    expect(homeBody).toContain("<JobsCard />")
    expect(homeBody).not.toContain("Suspense fallback={<Committed")
  })

  test("waits for all three counts before leaving the loading state", () => {
    const source = homeSource()
    const dashboard = source.slice(
      source.indexOf("function CommittedPullRequestsDashboard()"),
      source.indexOf("function RepositoryCards()"),
    )
    expect(dashboard).toContain("lastWeekQuery.isLoading")
    expect(dashboard).toContain("lastWeekQuery.isError")
    expect(dashboard).toContain("todayQuery.isLoading")
    expect(dashboard).toContain("yesterdayQuery.isLoading")
  })

  test("displays zero counts rather than hiding the dashboard", () => {
    const source = homeSource()
    const dashboard = source.slice(
      source.indexOf("function CommittedPullRequestsDashboard()"),
      source.indexOf("function RepositoryCards()"),
    )
    expect(dashboard).toContain("todayQuery.data ?? 0")
    expect(dashboard).toContain("yesterdayQuery.data ?? 0")
    expect(dashboard).toContain("lastWeekQuery.data ?? 0")
    expect(dashboard).toContain("{today}")
    expect(dashboard).toContain("{yesterday}")
    expect(dashboard).toContain("{lastWeek}")
  })

  test("hides PR dashboard and Jobs when no repositories are configured", () => {
    const source = homeSource()
    const homeBody = source.slice(
      source.indexOf("function HomeBody()"),
      source.indexOf("function CommittedPullRequestsDashboard()"),
    )
    expect(homeBody).toContain("repositories.length === 0")
    expect(homeBody).toContain("return <RepositoryCards />")
    const emptyBranch = homeBody.slice(
      homeBody.indexOf("repositories.length === 0"),
      homeBody.indexOf("return ("),
    )
    expect(emptyBranch).not.toContain("<CommittedPullRequestsDashboard")
    expect(emptyBranch).not.toContain("<JobsCard")
    expect(emptyBranch).not.toContain('aria-label="Committed pull requests"')
    expect(emptyBranch).not.toContain('aria-label="Jobs"')
  })
})
