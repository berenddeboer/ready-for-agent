import { localCommittedPullRequestDayBounds } from "./local-day-bounds.js"

export const statisticsWindows = [
  { value: "this-week", label: "This week" },
  { value: "last-week", label: "Last week" },
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "7", label: "Last 7 days" },
  { value: "28", label: "Last 28 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
] as const

export type StatisticsWindow = (typeof statisticsWindows)[number]["value"]

export function parseStatisticsWindow(raw: unknown): StatisticsWindow {
  // TanStack parses unquoted numeric query parameters as numbers.
  const value = typeof raw === "number" ? String(raw) : raw
  return (
    statisticsWindows.find((option) => option.value === value)?.value ??
    "this-week"
  )
}

/** Local calendar boundaries; current periods end now, past periods are complete. */
export function statisticsWindowBounds(
  window: StatisticsWindow,
  now = new Date(),
) {
  const to = now.toISOString()
  switch (window) {
    case "all":
      return { from: undefined, to }
    case "this-week": {
      const bounds = localCommittedPullRequestDayBounds(now)
      return { from: bounds.thisWeekFrom, to }
    }
    case "last-week": {
      const bounds = localCommittedPullRequestDayBounds(now)
      return { from: bounds.lastWeekFrom, to: bounds.lastWeekTo }
    }
    case "this-month":
      return {
        from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        to,
      }
    case "last-month":
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(),
        to: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      }
    case "7":
    case "28":
    case "90":
      return {
        from: new Date(
          now.getTime() - Number(window) * 86_400_000,
        ).toISOString(),
        to,
      }
  }
}
