/**
 * Merged-PR throughput strip — sticky root chrome on every route.
 */
import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Banner } from "./banner.js"
import { createHarnessGraphqlClient } from "./harness-graphql.js"
import {
  localCommittedPullRequestDayBounds,
  msUntilNextLocalMidnight,
} from "./local-day-bounds.js"
import { committedPullRequestsCountQueryKeyPrefix } from "./refresh-work-items-live.js"
import { ui } from "./ui.js"

const graphql = createHarnessGraphqlClient({ batch: true })

const committedPullRequestsCountQuery = (from: string, to: string) => ({
  queryKey: [...committedPullRequestsCountQueryKeyPrefix, from, to] as const,
  queryFn: async (): Promise<number> => {
    const result = await graphql.query({
      committedPullRequestsCount: {
        __args: { from, to },
      },
    })
    return result.committedPullRequestsCount
  },
})

export function CommittedPullRequestsDashboard() {
  const [bounds, setBounds] = useState(() =>
    localCommittedPullRequestDayBounds(),
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const syncBounds = () => {
      const next = localCommittedPullRequestDayBounds()
      setBounds((current) =>
        current.todayFrom === next.todayFrom && current.todayTo === next.todayTo
          ? current
          : next,
      )
    }
    const scheduleMidnightRollover = () => {
      timer = setTimeout(() => {
        syncBounds()
        scheduleMidnightRollover()
      }, msUntilNextLocalMidnight())
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") syncBounds()
    }
    scheduleMidnightRollover()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  const todayQuery = useQuery(
    committedPullRequestsCountQuery(bounds.todayFrom, bounds.todayTo),
  )
  const yesterdayQuery = useQuery(
    committedPullRequestsCountQuery(bounds.yesterdayFrom, bounds.yesterdayTo),
  )
  const thisWeekQuery = useQuery(
    committedPullRequestsCountQuery(bounds.thisWeekFrom, bounds.thisWeekTo),
  )
  const lastWeekQuery = useQuery(
    committedPullRequestsCountQuery(bounds.lastWeekFrom, bounds.lastWeekTo),
  )
  const twoWeeksAgoQuery = useQuery(
    committedPullRequestsCountQuery(
      bounds.twoWeeksAgoFrom,
      bounds.twoWeeksAgoTo,
    ),
  )
  const loading =
    todayQuery.isLoading ||
    yesterdayQuery.isLoading ||
    thisWeekQuery.isLoading ||
    lastWeekQuery.isLoading ||
    twoWeeksAgoQuery.isLoading
  const failed =
    todayQuery.isError ||
    yesterdayQuery.isError ||
    thisWeekQuery.isError ||
    lastWeekQuery.isError ||
    twoWeeksAgoQuery.isError

  if (loading) {
    return (
      <article
        className={ui.mergedPrStats}
        role="status"
        aria-label="Loading committed pull requests"
        aria-busy="true"
      >
        <div className={ui.mergedPrStatsGrid}>
          <div className={ui.mergedPrStatsCell}>
            <span className={ui.mergedPrStatsSkeleton} />
          </div>
          <div className={ui.mergedPrStatsCell}>
            <span className={ui.mergedPrStatsSkeleton} />
          </div>
          <div className={ui.mergedPrStatsCell}>
            <span className={ui.mergedPrStatsSkeleton} />
          </div>
          <div className={ui.mergedPrStatsCell}>
            <span className={ui.mergedPrStatsSkeleton} />
          </div>
          <div className={ui.mergedPrStatsCell}>
            <span className={ui.mergedPrStatsSkeleton} />
          </div>
        </div>
      </article>
    )
  }

  if (failed) {
    return (
      <article className={ui.mergedPrStats} aria-label="Merged PR throughput">
        <div className={ui.mergedPrStatsBody}>
          <Banner
            tone="alarm"
            tag="Error"
            role="alert"
            className={ui.bannerCompact}
          >
            Could not load committed pull requests. Please try again.
          </Banner>
        </div>
      </article>
    )
  }

  const today = todayQuery.data ?? 0
  const yesterday = yesterdayQuery.data ?? 0
  const thisWeek = thisWeekQuery.data ?? 0
  const lastWeek = lastWeekQuery.data ?? 0
  const twoWeeksAgo = twoWeeksAgoQuery.data ?? 0

  return (
    <article className={ui.mergedPrStats} aria-label="Merged PR throughput">
      <div className={ui.mergedPrStatsGrid}>
        <div className={ui.mergedPrStatsCell}>
          <span className={ui.mergedPrStatsLabel}>Today</span>
          <span className={ui.mergedPrStatsNum}>{today}</span>
        </div>
        <div className={ui.mergedPrStatsCell}>
          <span className={ui.mergedPrStatsLabel}>Yesterday</span>
          <span className={ui.mergedPrStatsNum}>{yesterday}</span>
        </div>
        <div className={ui.mergedPrStatsCell}>
          <span className={ui.mergedPrStatsLabel}>This week</span>
          <span className={ui.mergedPrStatsNum}>{thisWeek}</span>
        </div>
        <div className={ui.mergedPrStatsCell}>
          <span className={ui.mergedPrStatsLabel}>Last week</span>
          <span className={ui.mergedPrStatsNum}>{lastWeek}</span>
        </div>
        <div className={ui.mergedPrStatsCell}>
          <span className={ui.mergedPrStatsLabel}>Two weeks ago</span>
          <span className={ui.mergedPrStatsNum}>{twoWeeksAgo}</span>
        </div>
      </div>
    </article>
  )
}
