import {
  formatDuration,
  formatStartedAgo,
  isLiveDurationStatus,
  liveDurationMs,
} from "../src/live-duration.js"
import { describe, expect, test } from "bun:test"

describe("liveDurationMs", () => {
  test("advances a running snapshot without needing a query refetch", () => {
    const snapshotAtMs = 1_000_000
    const snapshotDurationMs = 78_000
    expect(
      liveDurationMs(snapshotDurationMs, true, snapshotAtMs, snapshotAtMs),
    ).toBe(78_000)
    expect(
      liveDurationMs(
        snapshotDurationMs,
        true,
        snapshotAtMs,
        snapshotAtMs + 1_000,
      ),
    ).toBe(79_000)
    expect(
      formatDuration(
        liveDurationMs(
          snapshotDurationMs,
          true,
          snapshotAtMs,
          snapshotAtMs + 1_000,
        )!,
      ),
    ).toBe("1m 19s")
  })

  test("keeps terminal durations fixed", () => {
    const snapshotAtMs = 1_000_000
    const finishedMs = 120_000
    for (const status of [
      "SUCCEEDED",
      "FAILED",
      "INTERRUPTED",
      "CANCELLED",
      "ABANDONED",
      "NEEDS_HUMAN",
      "QUEUED",
      "COMPLETE",
    ] as const) {
      expect(isLiveDurationStatus(status)).toBe(false)
      expect(
        liveDurationMs(
          finishedMs,
          isLiveDurationStatus(status),
          snapshotAtMs,
          snapshotAtMs + 30_000,
        ),
      ).toBe(finishedMs)
    }
  })

  test("resets baseline when query data updates with a new duration", () => {
    const firstSnapshotAt = 1_000_000
    const firstDuration = 78_000
    const advanced = liveDurationMs(
      firstDuration,
      true,
      firstSnapshotAt,
      firstSnapshotAt + 5_000,
    )
    expect(advanced).toBe(83_000)

    const secondSnapshotAt = firstSnapshotAt + 5_000
    const secondDuration = 80_000
    expect(
      liveDurationMs(secondDuration, true, secondSnapshotAt, secondSnapshotAt),
    ).toBe(80_000)
    expect(
      liveDurationMs(
        secondDuration,
        true,
        secondSnapshotAt,
        secondSnapshotAt + 2_000,
      ),
    ).toBe(82_000)
  })

  test("returns null when server duration is null", () => {
    expect(liveDurationMs(null, true, 1_000, 2_000)).toBeNull()
  })

  test("does not invent progress when snapshot time is unknown", () => {
    expect(liveDurationMs(78_000, true, 0, 50_000)).toBe(78_000)
  })
})

describe("formatStartedAgo", () => {
  test("advances relative age as wall clock moves without refetch", () => {
    const createdAt = new Date(1_000_000).toISOString()
    expect(formatStartedAgo(createdAt, 1_000_000 + 30_000)).toBe(
      "Started just now",
    )
    expect(formatStartedAgo(createdAt, 1_000_000 + 90_000)).toBe(
      "Started 1 min ago",
    )
    expect(formatStartedAgo(createdAt, 1_000_000 + 15 * 60_000)).toBe(
      "Started 15 min ago",
    )
  })
})

describe("formatDuration", () => {
  test("formats step durations used by lifecycle labels", () => {
    expect(formatDuration(3_000)).toBe("3s")
    expect(formatDuration(78_000)).toBe("1m 18s")
    expect(formatDuration(120_000)).toBe("2m")
  })
})
