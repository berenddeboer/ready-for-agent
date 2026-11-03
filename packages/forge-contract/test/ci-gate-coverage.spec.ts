import type { CiGateObservedRun } from "../src/index.js"
import {
  applyCatchUpHistoricalCoverage,
  applyLatestHistoricalCoverage,
  ciGateCoverageFromCheckpoint,
  ciGateRunOrderKey,
  nextCiGateCatchUpBound,
  pendingRunAboveFrontier,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const run = (
  id: number,
  conclusion: string | null,
  status = "completed",
): CiGateObservedRun => ({
  runIdentity: `${String(id)}:1`,
  htmlUrl: null,
  headSha: null,
  headRef: "main",
  event: "push",
  createdAt: new Date(Date.UTC(2026, 0, 1) + id * 1000),
  updatedAt: null,
  startedAt: null,
  rawStatus: status,
  rawConclusion: conclusion,
  orderKey: ciGateRunOrderKey(id, 1),
})

describe("CI Gate historical coverage", () => {
  it("treats an existing cursor as a checkpoint and opens a gap from the newest page", () => {
    const previous = ciGateCoverageFromCheckpoint({
      runIdentity: "100:1",
      orderKey: ciGateRunOrderKey(100, 1),
      createdAt: new Date("2025-12-01T00:00:00Z"),
      branch: "main",
    })
    const next = applyLatestHistoricalCoverage({
      previous,
      branch: "main",
      runs: [run(500, "failure"), run(400, "success")],
      historyExhausted: false,
      repairBaseline: null,
      baselineIrrelevant: true,
    })
    expect(next.state).toBe("gap")
    expect(next.checkpoint?.runIdentity).toBe("100:1")
    expect(next.gapUpper?.runIdentity).toBe("400:1")
    expect(nextCiGateCatchUpBound(next)?.runIdentity).toBe("400:1")
  })

  it("resumes catch-up from the committed frontier and does not restart the gap", () => {
    const opened = applyLatestHistoricalCoverage({
      previous: ciGateCoverageFromCheckpoint({
        runIdentity: "100:1",
        orderKey: ciGateRunOrderKey(100, 1),
        createdAt: new Date("2025-12-01T00:00:00Z"),
        branch: "main",
      }),
      branch: "main",
      runs: [run(500, "failure")],
      historyExhausted: false,
      repairBaseline: null,
      baselineIrrelevant: true,
    })
    const afterPage = applyCatchUpHistoricalCoverage({
      previous: opened,
      runs: [run(500, "failure"), run(300, "success"), run(250, "failure")],
      historyExhausted: false,
    })
    expect(afterPage.state).toBe("gap")
    expect(afterPage.gapUpper?.runIdentity).toBe("500:1")
    expect(afterPage.progress?.runIdentity).toBe("250:1")
    const withNewRuns = applyLatestHistoricalCoverage({
      previous: afterPage,
      branch: "main",
      runs: [run(900, "success"), run(800, "failure")],
      historyExhausted: false,
      repairBaseline: null,
      baselineIrrelevant: true,
    })
    expect(withNewRuns.gapUpper?.runIdentity).toBe("500:1")
    expect(withNewRuns.progress?.runIdentity).toBe("250:1")
    expect(nextCiGateCatchUpBound(withNewRuns)?.runIdentity).toBe("800:1")
  })

  it("remembers every pending run so a later one is still revisited", () => {
    const pending = Array.from({ length: 33 }, (_, index) =>
      run(1033 - index, null, "in_progress"),
    )
    const opened = applyLatestHistoricalCoverage({
      previous: ciGateCoverageFromCheckpoint({
        runIdentity: "100:1",
        orderKey: ciGateRunOrderKey(100, 1),
        createdAt: new Date("2025-12-01T00:00:00Z"),
        branch: "main",
      }),
      branch: "main",
      runs: [...pending, run(900, "success")],
      historyExhausted: false,
      repairBaseline: null,
      baselineIrrelevant: true,
    })
    expect(opened.pendingRuns).toHaveLength(33)
    expect(opened.pendingRuns.map((bound) => bound.runIdentity)).toContain(
      "1001:1",
    )
    const frontier = nextCiGateCatchUpBound(opened)
    expect(frontier?.runIdentity).toBe("900:1")
    expect(pendingRunAboveFrontier(opened, frontier!)?.runIdentity).toBe(
      "1033:1",
    )
    const decided = applyLatestHistoricalCoverage({
      previous: opened,
      branch: "main",
      runs: [run(1033, "success"), ...pending.slice(1), run(900, "success")],
      historyExhausted: false,
      repairBaseline: null,
      baselineIrrelevant: true,
    })
    expect(decided.pendingRuns.map((bound) => bound.runIdentity)).toContain(
      "1001:1",
    )
    expect(
      pendingRunAboveFrontier(decided, nextCiGateCatchUpBound(decided)!)
        ?.runIdentity,
    ).toBe("1032:1")
  })

  it("does not rewind catch-up to a pending run above the frontier", () => {
    const opened = applyLatestHistoricalCoverage({
      previous: ciGateCoverageFromCheckpoint({
        runIdentity: "100:1",
        orderKey: ciGateRunOrderKey(100, 1),
        createdAt: new Date("2025-12-01T00:00:00Z"),
        branch: "main",
      }),
      branch: "main",
      runs: [run(500, "failure")],
      historyExhausted: false,
      repairBaseline: null,
      baselineIrrelevant: true,
    })
    const afterPage = applyCatchUpHistoricalCoverage({
      previous: opened,
      runs: [
        run(500, "failure"),
        run(400, null, "in_progress"),
        run(300, "success"),
      ],
      historyExhausted: false,
    })
    expect(afterPage.progress?.runIdentity).toBe("300:1")
    expect(afterPage.pendingRuns.map((bound) => bound.runIdentity)).toContain(
      "400:1",
    )
    expect(nextCiGateCatchUpBound(afterPage)?.runIdentity).toBe("300:1")
    expect(
      pendingRunAboveFrontier(afterPage, nextCiGateCatchUpBound(afterPage)!)
        ?.runIdentity,
    ).toBe("400:1")
    const continued = applyCatchUpHistoricalCoverage({
      previous: afterPage,
      runs: [run(300, "success"), run(150, "failure")],
      historyExhausted: false,
    })
    expect(continued.progress?.runIdentity).toBe("150:1")
    expect(continued.gapUpper?.runIdentity).toBe("500:1")
    const withOlderPending = {
      ...afterPage,
      pendingRuns: [
        ...afterPage.pendingRuns,
        {
          runIdentity: "450:1",
          orderKey: ciGateRunOrderKey(450, 1),
          createdAt: new Date(Date.UTC(2026, 0, 1) + 450 * 1000),
        },
        {
          runIdentity: "420:1",
          orderKey: ciGateRunOrderKey(420, 1),
          createdAt: new Date(Date.UTC(2026, 0, 1) + 420 * 1000),
        },
      ],
    }
    const recorded = applyCatchUpHistoricalCoverage({
      previous: withOlderPending,
      runs: [run(300, "success"), run(150, "failure"), run(450, "success")],
      historyExhausted: false,
    })
    expect(recorded.progress?.runIdentity).toBe("150:1")
    expect(recorded.gapUpper?.runIdentity).toBe("500:1")
    expect(
      recorded.pendingRuns.map((bound) => bound.runIdentity),
    ).not.toContain("450:1")
    expect(
      pendingRunAboveFrontier(recorded, nextCiGateCatchUpBound(recorded)!)
        ?.runIdentity,
    ).toBe("420:1")
  })

  it("records a deleted checkpoint as incomplete when an older run remains", () => {
    const next = applyLatestHistoricalCoverage({
      previous: ciGateCoverageFromCheckpoint({
        runIdentity: "100:1",
        orderKey: ciGateRunOrderKey(100, 1),
        createdAt: new Date("2025-06-01T00:00:00Z"),
        branch: "main",
      }),
      branch: "main",
      runs: [run(80, "success"), run(50, "failure")],
      historyExhausted: true,
      repairBaseline: null,
      baselineIrrelevant: true,
    })
    expect(next.state).toBe("truncated")
    expect(next.diagnostic).toContain("checkpoint was not found")
  })

  it("terminates a missing checkpoint instead of scanning forever", () => {
    const opened = applyLatestHistoricalCoverage({
      previous: ciGateCoverageFromCheckpoint({
        runIdentity: "10:1",
        orderKey: ciGateRunOrderKey(10, 1),
        createdAt: new Date("2024-01-01T00:00:00Z"),
        branch: "main",
      }),
      branch: "main",
      runs: [run(500, "success")],
      historyExhausted: false,
      repairBaseline: null,
      baselineIrrelevant: true,
    })
    const truncated = applyCatchUpHistoricalCoverage({
      previous: opened,
      runs: [run(40, "success")],
      historyExhausted: true,
    })
    expect(truncated.state).toBe("truncated")
    expect(truncated.diagnostic).toContain("not in available history")
  })
})
