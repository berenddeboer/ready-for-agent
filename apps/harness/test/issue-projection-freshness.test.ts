import {
  ISSUE_PROJECTION_STALE_AFTER_MS,
  formatLastRefreshedAgo,
  isIssueProjectionStale,
} from "../src/issue-projection-freshness.js"
import { describe, expect, test } from "bun:test"

describe("isIssueProjectionStale", () => {
  const nowMs = Date.parse("2026-08-11T10:00:00.000Z")

  test("null is not stale (never refreshed is a different UI state)", () => {
    expect(isIssueProjectionStale(null, nowMs)).toBe(false)
  })

  test("a fresh timestamp is not stale", () => {
    const recent = new Date(nowMs - 60_000).toISOString()
    expect(isIssueProjectionStale(recent, nowMs)).toBe(false)
  })

  test("a timestamp just under the threshold is not stale", () => {
    const almost = new Date(
      nowMs - ISSUE_PROJECTION_STALE_AFTER_MS,
    ).toISOString()
    expect(isIssueProjectionStale(almost, nowMs)).toBe(false)
  })

  test("a timestamp older than the threshold is stale", () => {
    const old = new Date(
      nowMs - ISSUE_PROJECTION_STALE_AFTER_MS - 1,
    ).toISOString()
    expect(isIssueProjectionStale(old, nowMs)).toBe(true)
  })

  test("thirteen-hour-old projection from the #951 incident is stale", () => {
    const thirteenHoursAgo = new Date(nowMs - 13 * 60 * 60 * 1000).toISOString()
    expect(isIssueProjectionStale(thirteenHoursAgo, nowMs)).toBe(true)
  })

  test("unparseable timestamps are not treated as stale", () => {
    expect(isIssueProjectionStale("not-a-date", nowMs)).toBe(false)
  })
})

describe("formatLastRefreshedAgo", () => {
  const nowMs = Date.parse("2026-08-11T10:00:00.000Z")

  test("formats minutes, hours, and days for the stale caption", () => {
    expect(
      formatLastRefreshedAgo(new Date(nowMs - 45_000).toISOString(), nowMs),
    ).toBe("Last refreshed just now")
    expect(
      formatLastRefreshedAgo(
        new Date(nowMs - 15 * 60_000).toISOString(),
        nowMs,
      ),
    ).toBe("Last refreshed 15 min ago")
    expect(
      formatLastRefreshedAgo(
        new Date(nowMs - 60 * 60_000).toISOString(),
        nowMs,
      ),
    ).toBe("Last refreshed 1 hour ago")
    expect(
      formatLastRefreshedAgo(
        new Date(nowMs - 13 * 60 * 60_000).toISOString(),
        nowMs,
      ),
    ).toBe("Last refreshed 13 hours ago")
    expect(
      formatLastRefreshedAgo(
        new Date(nowMs - 26 * 60 * 60_000).toISOString(),
        nowMs,
      ),
    ).toBe("Last refreshed 1 day ago")
    expect(
      formatLastRefreshedAgo(
        new Date(nowMs - 3 * 24 * 60 * 60_000).toISOString(),
        nowMs,
      ),
    ).toBe("Last refreshed 3 days ago")
  })
})
