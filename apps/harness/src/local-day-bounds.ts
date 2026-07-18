/** Local calendar-day bounds as ISO instants for the PR dashboard query. */
export const localCommittedPullRequestDayBounds = (now = new Date()) => {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const startOfTomorrow = new Date(startOfToday)
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1)
  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)
  return {
    todayFrom: startOfToday.toISOString(),
    todayTo: startOfTomorrow.toISOString(),
    yesterdayFrom: startOfYesterday.toISOString(),
    yesterdayTo: startOfToday.toISOString(),
  }
}
