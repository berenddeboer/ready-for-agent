import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const homeSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

const repositoriesQuerySource = () =>
  readFileSync(join(import.meta.dir, "../src/repositories-query.ts"), "utf8")

const refreshSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/refresh-work-items-live.ts"),
    "utf8",
  )

const openPrCountLiveSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/refresh-open-pull-request-count-live.ts"),
    "utf8",
  )

const membershipLiveSource = () =>
  readFileSync(
    join(import.meta.dir, "../src/refresh-repositories-live.ts"),
    "utf8",
  )

describe("repository header pull request count", () => {
  test("main repositories query does not request pullRequestCount", () => {
    const source = repositoriesQuerySource()
    const home = homeSource()
    // Shared module owns Configured Repositories; home re-exports it.
    expect(home).toContain('from "./repositories-query.js"')
    expect(home).toContain("export { repositoriesQuery }")
    // Dedicated projection owns the count field; the Configured Repositories
    // selection must not include it.
    expect(source).toContain("Intentionally omits pullRequestCount")
    const repositoriesQueryStart = source.indexOf(
      "export const repositoriesQuery = {",
    )
    expect(repositoriesQueryStart).toBeGreaterThan(-1)
    const repositoriesQueryBody = source.slice(repositoriesQueryStart)
    expect(repositoriesQueryBody).not.toContain("pullRequestCount: true")
  })

  test("dedicated openPullRequestCountsQuery requests pullRequestCount", () => {
    const source = homeSource()
    // Module-local (not exported): knip treats an unused export as a failure.
    expect(source).toContain("const openPullRequestCountsQuery = {")
    expect(source).not.toContain("export const openPullRequestCountsQuery")
    expect(source).toContain("openPullRequestCountsQueryKey")
    const openCountsStart = source.indexOf(
      "const openPullRequestCountsQuery = {",
    )
    const openCountsEnd = source.indexOf(
      "export const issuesQuery",
      openCountsStart,
    )
    expect(openCountsEnd).toBeGreaterThan(openCountsStart)
    const body = source.slice(openCountsStart, openCountsEnd)
    expect(body).toContain("pullRequestCount: true")
    expect(body).toContain("id: true")
  })

  test("header renders the count immediately after the repository name", () => {
    const source = homeSource()
    const titleIndex = source.indexOf("title={pullRequestCountLabel}")
    expect(titleIndex).toBeGreaterThan(-1)
    // Count sits in the same h2 as the repository name link.
    const headerStart = source.lastIndexOf("<h2", titleIndex)
    const headerEnd = source.indexOf("</h2>", titleIndex)
    expect(headerStart).toBeGreaterThan(-1)
    expect(headerEnd).toBeGreaterThan(titleIndex)
    const header = source.slice(headerStart, headerEnd)
    const nameInHeader = header.indexOf("{repositoryLabel}")
    const countInHeader = header.indexOf("{pullRequestCountDisplay}")
    expect(nameInHeader).toBeGreaterThan(-1)
    expect(countInHeader).toBeGreaterThan(nameInHeader)
    expect(header).toContain('className="sr-only"')
    expect(header).toContain("{pullRequestCountLabel}")
    expect(header).toContain('aria-hidden="true"')
    expect(header).toContain("ui.repoCardPrCount")
  })

  test("header uses presentation helper with isPending and isFetching", () => {
    const source = homeSource()
    expect(source).toContain("openPullRequestCountPresentation")
    expect(source).toContain("isFetching: openPullRequestCountsFetching")
    expect(source).toContain("isPending: openPullRequestCountsPending")
    expect(source).toContain(
      "aria-busy={pullRequestCountLoading ? true : undefined}",
    )
  })

  test("uses dedicated GitHub-backed live refresh independent of repositoriesQuery", () => {
    const home = homeSource()
    expect(home).toContain("followOpenPullRequestCountLive")
    expect(home).toContain("openPullRequestCountsQuery")
    // Follower must receive the dedicated query, not repositoriesQuery.
    expect(home).toMatch(
      /followOpenPullRequestCountLive\(\{\s*queryClient,\s*openPullRequestCountsQuery,/,
    )
    // Repository membership SSE is owned by the transport-health follower;
    // catch-up fire-and-forgets dedicated counts and never couples warning
    // state to count latency.
    expect(home).toContain("followRepositoryMembershipLive")
    expect(home).toContain("liveUpdatesWarningPresentation")
    expect(home).toContain("onLiveUpdatesUnavailable")

    const membership = membershipLiveSource()
    expect(membership).toContain("openPullRequestCountsQueryKey")
    expect(membership).toMatch(
      /invalidateQueries\(\{\s*queryKey:\s*openPullRequestCountsQueryKey\s*\}\)/,
    )
    expect(membership).toContain("scheduleCatchUp")
    expect(membership).toContain("Fire-and-forget")
    expect(membership).toContain("transport health")

    const live = openPrCountLiveSource()
    expect(live).toContain("OPEN_PULL_REQUEST_COUNT_POLL_INTERVAL_MS")
    expect(live).toContain("openPullRequestCountsQueryKey")
    expect(live).toContain("openPullRequestCountPresentation")
    expect(live).toContain("visibilitychange")
    expect(live).toContain("GitHub-authoritative")
    expect(live).toContain("External PR changes do not emit Work Item SSE")
    expect(live).toContain("Never cancels")
    expect(live).toContain("Configured Repositories")
  })

  test("work-item live refresh fire-and-forgets dedicated count without awaiting", () => {
    const source = refreshSource()
    expect(source).toContain("openPullRequestCountsQueryKey")
    expect(source).toContain("scheduleOpenPullRequestCounts")
    expect(source).toContain("Fire-and-forget")
    expect(source).toContain("openPrCountsRefreshPending")
    expect(source).toContain('const repositoriesQueryKey = ["repositories"]')
    // Must not await the dedicated count projection on the SSE path.
    expect(source).toMatch(
      /scheduleOpenPullRequestCounts\(\)\s*\n\s*await Promise\.all/,
    )
  })
})
