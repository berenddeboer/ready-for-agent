import { readFileSync } from "node:fs"
import { join } from "node:path"
import { localCommittedPullRequestDayBounds } from "../src/local-day-bounds.ts"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

describe("localCommittedPullRequestDayBounds", () => {
  test("uses local calendar day start/end as ISO instants (mid-week Saturday)", () => {
    // 2026-07-18 is a Saturday
    const now = new Date(2026, 6, 18, 15, 30, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(now)
    const todayStart = new Date(2026, 6, 18, 0, 0, 0, 0)
    const tomorrowStart = new Date(2026, 6, 19, 0, 0, 0, 0)
    const yesterdayStart = new Date(2026, 6, 17, 0, 0, 0, 0)
    const thisWeekStart = new Date(2026, 6, 13, 0, 0, 0, 0) // Monday
    const lastWeekStart = new Date(2026, 6, 6, 0, 0, 0, 0) // previous Monday
    expect(bounds.todayFrom).toBe(todayStart.toISOString())
    expect(bounds.todayTo).toBe(tomorrowStart.toISOString())
    expect(bounds.yesterdayFrom).toBe(yesterdayStart.toISOString())
    expect(bounds.yesterdayTo).toBe(todayStart.toISOString())
    expect(bounds.thisWeekFrom).toBe(thisWeekStart.toISOString())
    expect(bounds.thisWeekTo).toBe(tomorrowStart.toISOString())
    expect(bounds.lastWeekFrom).toBe(lastWeekStart.toISOString())
    expect(bounds.lastWeekTo).toBe(thisWeekStart.toISOString())
  })

  test("mid-week Wednesday: this week and last week do not overlap", () => {
    // 2026-07-22 is a Wednesday (issue example)
    const now = new Date(2026, 6, 22, 12, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(now)
    expect(bounds.thisWeekFrom).toBe(
      new Date(2026, 6, 20, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.thisWeekTo).toBe(
      new Date(2026, 6, 23, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekFrom).toBe(
      new Date(2026, 6, 13, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekTo).toBe(
      new Date(2026, 6, 20, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekTo).toBe(bounds.thisWeekFrom)
    expect(bounds.yesterdayFrom >= bounds.lastWeekTo).toBe(true)
    expect(bounds.todayFrom >= bounds.thisWeekFrom).toBe(true)
    expect(bounds.todayTo).toBe(bounds.thisWeekTo)
  })

  test("week starts on Monday when today is Monday", () => {
    // 2026-07-20 is a Monday
    const now = new Date(2026, 6, 20, 9, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(now)
    const monday = new Date(2026, 6, 20, 0, 0, 0, 0)
    const tuesday = new Date(2026, 6, 21, 0, 0, 0, 0)
    const prevMonday = new Date(2026, 6, 13, 0, 0, 0, 0)
    expect(bounds.thisWeekFrom).toBe(monday.toISOString())
    expect(bounds.thisWeekTo).toBe(tuesday.toISOString())
    expect(bounds.lastWeekFrom).toBe(prevMonday.toISOString())
    expect(bounds.lastWeekTo).toBe(monday.toISOString())
    expect(bounds.todayFrom).toBe(monday.toISOString())
  })

  test("week starts on Monday when today is Sunday", () => {
    // 2026-03-15 is a Sunday
    const now = new Date(2026, 2, 15, 12, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(now)
    expect(bounds.thisWeekFrom).toBe(
      new Date(2026, 2, 9, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.thisWeekTo).toBe(
      new Date(2026, 2, 16, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekFrom).toBe(
      new Date(2026, 2, 2, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekTo).toBe(
      new Date(2026, 2, 9, 0, 0, 0, 0).toISOString(),
    )
  })

  test("handles month and year transitions", () => {
    // 2026-01-01 is a Thursday
    const newYear = new Date(2026, 0, 1, 9, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(newYear)
    expect(bounds.yesterdayFrom).toBe(
      new Date(2025, 11, 31, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.yesterdayTo).toBe(
      new Date(2026, 0, 1, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.todayTo).toBe(new Date(2026, 0, 2, 0, 0, 0, 0).toISOString())
    expect(bounds.thisWeekFrom).toBe(
      new Date(2025, 11, 29, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.thisWeekTo).toBe(
      new Date(2026, 0, 2, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekFrom).toBe(
      new Date(2025, 11, 22, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekTo).toBe(
      new Date(2025, 11, 29, 0, 0, 0, 0).toISOString(),
    )
  })

  test("last week is previous complete Mon–Sun local calendar week", () => {
    const now = new Date(2026, 2, 15, 12, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(now)
    const lastWeekFrom = new Date(bounds.lastWeekFrom)
    const lastWeekTo = new Date(bounds.lastWeekTo)
    const thisWeekFrom = new Date(bounds.thisWeekFrom)
    expect(lastWeekTo.getTime()).toBe(thisWeekFrom.getTime())
    expect(lastWeekFrom.getDay()).toBe(1)
    expect(lastWeekTo.getDay()).toBe(1)
    const msPerDay = 24 * 60 * 60 * 1000
    expect(
      (lastWeekTo.getTime() - lastWeekFrom.getTime()) / msPerDay,
    ).toBeCloseTo(7, 5)
    // When yesterday is still in the current week, it is outside last week.
    expect(bounds.yesterdayFrom >= bounds.lastWeekTo).toBe(true)
  })

  test("handles spring-forward daylight-saving local midnight", () => {
    // US Pacific 2026: clocks spring forward 2026-03-08 02:00 → 03:00
    // 2026-03-09 is a Monday
    const afterSpringForward = new Date(2026, 2, 9, 10, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(afterSpringForward)
    expect(bounds.lastWeekFrom).toBe(
      new Date(2026, 2, 2, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekTo).toBe(
      new Date(2026, 2, 9, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.thisWeekFrom).toBe(
      new Date(2026, 2, 9, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.thisWeekTo).toBe(
      new Date(2026, 2, 10, 0, 0, 0, 0).toISOString(),
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
    // 2026-11-02 is a Monday
    const afterFallBack = new Date(2026, 10, 2, 10, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(afterFallBack)
    expect(bounds.lastWeekFrom).toBe(
      new Date(2026, 9, 26, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekTo).toBe(
      new Date(2026, 10, 2, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.thisWeekFrom).toBe(
      new Date(2026, 10, 2, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.thisWeekTo).toBe(
      new Date(2026, 10, 3, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.yesterdayFrom).toBe(
      new Date(2026, 10, 1, 0, 0, 0, 0).toISOString(),
    )
  })
})

describe("Committed pull requests dashboard UI", () => {
  test("renders above the Jobs card with Today, Yesterday, This week, and Last week labels", () => {
    const source = homeSource()
    const dashboardIndex = source.indexOf(
      'aria-label="Committed pull requests"',
    )
    const jobsIndex = source.indexOf('aria-label="Jobs"')
    expect(dashboardIndex).toBeGreaterThan(-1)
    expect(jobsIndex).toBeGreaterThan(dashboardIndex)
    expect(source).toContain("Today")
    expect(source).toContain("Yesterday")
    expect(source).toContain("This week")
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
    expect(dashboard).toContain("bounds.thisWeekFrom")
    expect(dashboard).toContain("bounds.thisWeekTo")
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
    expect(source).toContain("grid-cols-4")
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

  test("waits for all four counts before leaving the loading state", () => {
    const source = homeSource()
    const dashboard = source.slice(
      source.indexOf("function CommittedPullRequestsDashboard()"),
      source.indexOf("function RepositoryCards()"),
    )
    expect(dashboard).toContain("thisWeekQuery.isLoading")
    expect(dashboard).toContain("thisWeekQuery.isError")
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
    expect(dashboard).toContain("thisWeekQuery.data ?? 0")
    expect(dashboard).toContain("lastWeekQuery.data ?? 0")
    expect(dashboard).toContain("{today}")
    expect(dashboard).toContain("{yesterday}")
    expect(dashboard).toContain("{thisWeek}")
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
