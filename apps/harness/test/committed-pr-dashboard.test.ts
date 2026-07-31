import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  localCommittedPullRequestDayBounds,
  msUntilNextLocalMidnight,
} from "../src/local-day-bounds.ts"
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
    const twoWeeksAgoStart = new Date(2026, 5, 29, 0, 0, 0, 0) // Monday before that
    expect(bounds.todayFrom).toBe(todayStart.toISOString())
    expect(bounds.todayTo).toBe(tomorrowStart.toISOString())
    expect(bounds.yesterdayFrom).toBe(yesterdayStart.toISOString())
    expect(bounds.yesterdayTo).toBe(todayStart.toISOString())
    expect(bounds.thisWeekFrom).toBe(thisWeekStart.toISOString())
    expect(bounds.thisWeekTo).toBe(tomorrowStart.toISOString())
    expect(bounds.lastWeekFrom).toBe(lastWeekStart.toISOString())
    expect(bounds.lastWeekTo).toBe(thisWeekStart.toISOString())
    expect(bounds.twoWeeksAgoFrom).toBe(twoWeeksAgoStart.toISOString())
    expect(bounds.twoWeeksAgoTo).toBe(lastWeekStart.toISOString())
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
    expect(bounds.twoWeeksAgoFrom).toBe(
      new Date(2026, 6, 6, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.twoWeeksAgoTo).toBe(
      new Date(2026, 6, 13, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.lastWeekTo).toBe(bounds.thisWeekFrom)
    expect(bounds.twoWeeksAgoTo).toBe(bounds.lastWeekFrom)
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
    const twoWeeksAgoMonday = new Date(2026, 6, 6, 0, 0, 0, 0)
    expect(bounds.thisWeekFrom).toBe(monday.toISOString())
    expect(bounds.thisWeekTo).toBe(tuesday.toISOString())
    expect(bounds.lastWeekFrom).toBe(prevMonday.toISOString())
    expect(bounds.lastWeekTo).toBe(monday.toISOString())
    expect(bounds.twoWeeksAgoFrom).toBe(twoWeeksAgoMonday.toISOString())
    expect(bounds.twoWeeksAgoTo).toBe(prevMonday.toISOString())
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
    expect(bounds.twoWeeksAgoFrom).toBe(
      new Date(2026, 1, 23, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.twoWeeksAgoTo).toBe(
      new Date(2026, 2, 2, 0, 0, 0, 0).toISOString(),
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
    expect(bounds.twoWeeksAgoFrom).toBe(
      new Date(2025, 11, 15, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.twoWeeksAgoTo).toBe(
      new Date(2025, 11, 22, 0, 0, 0, 0).toISOString(),
    )
  })

  test("last week and two weeks ago are complete Mon–Sun local calendar weeks", () => {
    const now = new Date(2026, 2, 15, 12, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(now)
    const lastWeekFrom = new Date(bounds.lastWeekFrom)
    const lastWeekTo = new Date(bounds.lastWeekTo)
    const thisWeekFrom = new Date(bounds.thisWeekFrom)
    const twoWeeksAgoFrom = new Date(bounds.twoWeeksAgoFrom)
    const twoWeeksAgoTo = new Date(bounds.twoWeeksAgoTo)
    expect(lastWeekTo.getTime()).toBe(thisWeekFrom.getTime())
    expect(twoWeeksAgoTo.getTime()).toBe(lastWeekFrom.getTime())
    expect(lastWeekFrom.getDay()).toBe(1)
    expect(lastWeekTo.getDay()).toBe(1)
    expect(twoWeeksAgoFrom.getDay()).toBe(1)
    expect(twoWeeksAgoTo.getDay()).toBe(1)
    const msPerDay = 24 * 60 * 60 * 1000
    expect(
      (lastWeekTo.getTime() - lastWeekFrom.getTime()) / msPerDay,
    ).toBeCloseTo(7, 5)
    expect(
      (twoWeeksAgoTo.getTime() - twoWeeksAgoFrom.getTime()) / msPerDay,
    ).toBeCloseTo(7, 5)
    // When yesterday is still in the current week, it is outside last week.
    expect(bounds.yesterdayFrom >= bounds.lastWeekTo).toBe(true)
  })

  test("handles spring-forward daylight-saving local midnight", () => {
    // US Pacific 2026: clocks spring forward 2026-03-08 02:00 → 03:00
    // 2026-03-09 is a Monday
    const afterSpringForward = new Date(2026, 2, 9, 10, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(afterSpringForward)
    expect(bounds.twoWeeksAgoFrom).toBe(
      new Date(2026, 1, 23, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.twoWeeksAgoTo).toBe(
      new Date(2026, 2, 2, 0, 0, 0, 0).toISOString(),
    )
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

  test("msUntilNextLocalMidnight is positive and lands on local midnight", () => {
    const now = new Date(2026, 6, 22, 15, 30, 0, 0)
    const ms = msUntilNextLocalMidnight(now)
    expect(ms).toBeGreaterThan(0)
    const rolled = new Date(now.getTime() + ms)
    expect(rolled.getHours()).toBe(0)
    expect(rolled.getMinutes()).toBe(0)
    expect(rolled.getDate()).toBe(23)
  })

  test("handles fall-back daylight-saving local midnight", () => {
    // US Pacific 2026: clocks fall back 2026-11-01 02:00 → 01:00
    // 2026-11-02 is a Monday
    const afterFallBack = new Date(2026, 10, 2, 10, 0, 0, 0)
    const bounds = localCommittedPullRequestDayBounds(afterFallBack)
    expect(bounds.twoWeeksAgoFrom).toBe(
      new Date(2026, 9, 19, 0, 0, 0, 0).toISOString(),
    )
    expect(bounds.twoWeeksAgoTo).toBe(
      new Date(2026, 9, 26, 0, 0, 0, 0).toISOString(),
    )
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
  test("renders above the pipeline board with Today, Yesterday, This week, Last week, and Two weeks ago labels", () => {
    const source = homeSource()
    const board = readFileSync(
      join(import.meta.dir, "../src/kanban-board.tsx"),
      "utf8",
    )
    const dashboardIndex = board.indexOf('aria-label="Committed pull requests"')
    const jobsIndex = board.indexOf('aria-label="Jobs"')
    expect(dashboardIndex).toBeGreaterThan(-1)
    expect(jobsIndex).toBeGreaterThan(dashboardIndex)
    expect(source).toContain("Today")
    expect(source).toContain("Yesterday")
    expect(source).toContain("This week")
    expect(source).toContain("Last week")
    expect(source).toContain("Two weeks ago")
    expect(source).toContain("function CommittedPullRequestsDashboard()")
  })

  test("loads counts via dedicated aggregate query with local day bounds", () => {
    const source = homeSource()
    expect(source).toContain("committedPullRequestsCount")
    expect(source).toContain("localCommittedPullRequestDayBounds")
    expect(source).toContain("committedPullRequestsCountQueryKeyPrefix")
    expect(source).toContain(
      "queryKey: [...committedPullRequestsCountQueryKeyPrefix, from, to]",
    )
    const dashboard = source.slice(
      source.indexOf("function CommittedPullRequestsDashboard()"),
      source.indexOf("function RepositoryCards()"),
    )
    expect(dashboard).toContain("bounds.thisWeekFrom")
    expect(dashboard).toContain("bounds.thisWeekTo")
    expect(dashboard).toContain("bounds.lastWeekFrom")
    expect(dashboard).toContain("bounds.lastWeekTo")
    expect(dashboard).toContain("bounds.twoWeeksAgoFrom")
    expect(dashboard).toContain("bounds.twoWeeksAgoTo")
    expect(dashboard).not.toContain("workItems")
    expect(dashboard).not.toContain("JOBS_COMPLETED_WINDOW_HOURS")
    expect(dashboard).not.toContain("JOBS_COMPLETED_LIMIT")
  })

  test("stays live via work-items subscription without polling", () => {
    const source = homeSource()
    expect(source).toContain("followRepositoryWorkItemsLive")
    expect(source).toContain("committedPullRequestsCountQueryKeyPrefix")
    const dashboard = source.slice(
      source.indexOf("function CommittedPullRequestsDashboard()"),
      source.indexOf("function RepositoryCards()"),
    )
    expect(dashboard).not.toContain("refetchInterval")
    const refreshSource = readFileSync(
      join(import.meta.dir, "../src/refresh-work-items-live.ts"),
      "utf8",
    )
    expect(refreshSource).toContain("refreshCommittedPullRequestsCounts")
    expect(refreshSource).toContain("committedPullRequestsCountQueryKeyPrefix")
    expect(refreshSource).toContain('"committed-pull-requests-count"')
  })

  test("rolls day bounds at local midnight and on tab visibility", () => {
    const source = homeSource()
    const dashboard = source.slice(
      source.indexOf("function CommittedPullRequestsDashboard()"),
      source.indexOf("function RepositoryCards()"),
    )
    expect(dashboard).toContain("msUntilNextLocalMidnight")
    expect(dashboard).toContain("scheduleMidnightRollover")
    expect(dashboard).toContain("visibilitychange")
    expect(dashboard).toContain("setBounds")
  })

  test("shows loading and error states without blocking the board", () => {
    const source = homeSource()
    const board = readFileSync(
      join(import.meta.dir, "../src/kanban-board.tsx"),
      "utf8",
    )
    expect(source).toContain('aria-label="Loading committed pull requests"')
    expect(source).toContain('role="status"')
    expect(source).toContain('aria-busy="true"')
    expect(source).toContain("grid-cols-5")
    expect(source).toContain(
      "Could not load committed pull requests. Please try again.",
    )
    expect(source).toContain('role="alert"')
    // Board mounts dashboard as a sibling of the pipeline (no Suspense around it).
    expect(board).toContain("<CommittedPullRequestsDashboard />")
    expect(board).toContain("<KanbanJobsBoard />")
    expect(board).not.toContain("Suspense fallback={<Committed")
  })

  test("waits for all five counts before leaving the loading state", () => {
    const source = homeSource()
    const dashboard = source.slice(
      source.indexOf("function CommittedPullRequestsDashboard()"),
      source.indexOf("function RepositoryCards()"),
    )
    expect(dashboard).toContain("thisWeekQuery.isLoading")
    expect(dashboard).toContain("thisWeekQuery.isError")
    expect(dashboard).toContain("lastWeekQuery.isLoading")
    expect(dashboard).toContain("lastWeekQuery.isError")
    expect(dashboard).toContain("twoWeeksAgoQuery.isLoading")
    expect(dashboard).toContain("twoWeeksAgoQuery.isError")
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
    expect(dashboard).toContain("twoWeeksAgoQuery.data ?? 0")
    expect(dashboard).toContain("{today}")
    expect(dashboard).toContain("{yesterday}")
    expect(dashboard).toContain("{thisWeek}")
    expect(dashboard).toContain("{lastWeek}")
    expect(dashboard).toContain("{twoWeeksAgo}")
  })

  test("board shows PR dashboard and pipeline; zero repos use blank slate", () => {
    const home = homeSource()
    const board = readFileSync(
      join(import.meta.dir, "../src/kanban-board.tsx"),
      "utf8",
    )
    expect(board).toContain("<CommittedPullRequestsDashboard />")
    expect(board).toContain('aria-label="Committed pull requests"')
    expect(board).toContain('aria-label="Jobs"')
    expect(board).toContain("<KanbanJobsBoard />")
    expect(board).not.toContain("RepositoryCards")
    // Zero-repo gate lives on home; board assumes repositories exist.
    const homeContent = home.slice(
      home.indexOf("function HomeContent()"),
      home.indexOf("export function EmptyRepositoriesBlankSlate()"),
    )
    expect(homeContent).toContain("(repositories ?? []).length === 0")
    expect(homeContent).toContain("<EmptyRepositoriesBlankSlate />")
    expect(homeContent).toContain("<KanbanBoard />")
  })
})
