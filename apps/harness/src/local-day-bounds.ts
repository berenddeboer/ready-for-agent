/** Local calendar-day bounds as ISO instants for the PR dashboard query. */
export const localCommittedPullRequestDayBounds = (now = new Date()) => {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const startOfTomorrow = new Date(startOfToday)
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1)
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  // ISO-8601 weeks start Monday (getDay: 0=Sun … 6=Sat).
  const day = startOfToday.getDay()
  const daysSinceMonday = day === 0 ? 6 : day - 1
  const startOfThisWeek = new Date(startOfToday)
  startOfThisWeek.setDate(startOfThisWeek.getDate() - daysSinceMonday)
  const startOfLastWeek = new Date(startOfThisWeek)
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7)
  return {
    todayFrom: startOfToday.toISOString(),
    todayTo: startOfTomorrow.toISOString(),
    yesterdayFrom: startOfYesterday.toISOString(),
    yesterdayTo: startOfToday.toISOString(),
    thisWeekFrom: startOfThisWeek.toISOString(),
    thisWeekTo: startOfTomorrow.toISOString(),
    lastWeekFrom: startOfLastWeek.toISOString(),
    lastWeekTo: startOfThisWeek.toISOString(),
  }
}
