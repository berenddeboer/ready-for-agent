import {
  CI_GATE_RESOLVED_HISTORY_WINDOW_MS,
  isResolvedCiFailureIncidentWithinHistoryWindow,
  resolvedCiFailureIncidentHistorySinceMs,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const NOW = Date.parse("2026-11-12T00:00:00.000Z")

describe("resolved CI Failure Incident history window", () => {
  it("is the rolling previous 7 × 24 hours, inclusive of the cutoff", () => {
    expect(CI_GATE_RESOLVED_HISTORY_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000)
    const cutoff = resolvedCiFailureIncidentHistorySinceMs(NOW)
    expect(cutoff).toBe(NOW - CI_GATE_RESOLVED_HISTORY_WINDOW_MS)
    expect(
      isResolvedCiFailureIncidentWithinHistoryWindow({
        resolvedAtMs: cutoff,
        nowMs: NOW,
      }),
    ).toBe(true)
    expect(
      isResolvedCiFailureIncidentWithinHistoryWindow({
        resolvedAtMs: cutoff - 1,
        nowMs: NOW,
      }),
    ).toBe(false)
    expect(
      isResolvedCiFailureIncidentWithinHistoryWindow({
        resolvedAtMs: null,
        nowMs: NOW,
      }),
    ).toBe(false)
  })
})
