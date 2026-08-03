import { PIPELINE_LANES, type PipelineLaneId } from "../src/pipeline-lanes.js"
import {
  ROUTE_FED_MS,
  ROUTE_SMOKE_MS,
  ROUTE_TRANSITION_MS,
  ROUTE_TRANSITION_TOTAL_MS,
  type RouteFlight,
  assignmentsEqual,
  countPendingArrivals,
  createRouteFlight,
  displayLaneCount,
  displayLaneCounts,
  laneAssignmentFromLaneItems,
  laneCenterPercent,
  laneItemsAssignmentKey,
  nextFlightPhase,
  phaseDurationMs,
  planLaneTransitions,
  reconcileFlights,
  trueLaneCounts,
} from "../src/pipeline-route-transition.js"
import { describe, expect, test } from "bun:test"

const assignment = (
  entries: readonly (readonly [string, PipelineLaneId])[],
): Map<string, PipelineLaneId> => new Map(entries)

describe("assignmentsEqual", () => {
  test("compares content, not Map identity", () => {
    const left = assignment([["a", "build"]])
    const right = assignment([["a", "build"]])
    expect(left).not.toBe(right)
    expect(assignmentsEqual(left, right)).toBe(true)
    expect(assignmentsEqual(left, assignment([["a", "review"]]))).toBe(false)
    expect(assignmentsEqual(left, assignment([]))).toBe(false)
  })
})

describe("planLaneTransitions", () => {
  test("returns empty when assignments are identical", () => {
    const map = assignment([
      ["a", "build"],
      ["b", "review"],
    ])
    expect(planLaneTransitions(map, map)).toEqual([])
  })

  test("plans a single Build → Review move", () => {
    const previous = assignment([["job-1", "build"]])
    const next = assignment([["job-1", "review"]])
    expect(planLaneTransitions(previous, next)).toEqual([
      { workItemId: "job-1", from: "build", to: "review" },
    ])
  })

  test("plans non-adjacent moves without inventing intermediate stops", () => {
    const previous = assignment([["job-1", "build"]])
    const next = assignment([["job-1", "pr"]])
    expect(planLaneTransitions(previous, next)).toEqual([
      { workItemId: "job-1", from: "build", to: "pr" },
    ])
  })

  test("plans multiple concurrent moves", () => {
    const previous = assignment([
      ["a", "build"],
      ["b", "build"],
      ["c", "review"],
    ])
    const next = assignment([
      ["a", "review"],
      ["b", "review"],
      ["c", "pr"],
    ])
    expect(planLaneTransitions(previous, next)).toEqual([
      { workItemId: "a", from: "build", to: "review" },
      { workItemId: "b", from: "build", to: "review" },
      { workItemId: "c", from: "review", to: "pr" },
    ])
  })

  test("ignores items that only appear or only disappear", () => {
    const previous = assignment([
      ["gone", "build"],
      ["stays", "review"],
    ])
    const next = assignment([
      ["new", "queue"],
      ["stays", "review"],
    ])
    expect(planLaneTransitions(previous, next)).toEqual([])
  })
})

describe("displayLaneCount / displayLaneCounts", () => {
  test("delays destination count while arrivals are pending", () => {
    expect(displayLaneCount({ trueCount: 3, pendingArrivals: 1 })).toBe(2)
    expect(displayLaneCount({ trueCount: 1, pendingArrivals: 1 })).toBe(0)
  })

  test("never shows a negative count", () => {
    expect(displayLaneCount({ trueCount: 0, pendingArrivals: 2 })).toBe(0)
  })

  test("source matches true count when no pending arrivals there", () => {
    const trueCounts = new Map<PipelineLaneId, number>([
      ["queue", 0],
      ["build", 1],
      ["review", 2],
      ["pr", 0],
      ["attention", 0],
      ["complete", 0],
    ])
    const flights: Pick<RouteFlight, "to">[] = [{ to: "review" }]
    const display = displayLaneCounts(trueCounts, flights)
    // Source already decremented in true data; dest holds +1 until absorb.
    expect(display.get("build")).toBe(1)
    expect(display.get("review")).toBe(1)
  })

  test("overlapping arrivals stack without losing the final true count", () => {
    const trueCounts = new Map<PipelineLaneId, number>([
      ["queue", 0],
      ["build", 0],
      ["review", 3],
      ["pr", 0],
      ["attention", 0],
      ["complete", 0],
    ])
    const flights: Pick<RouteFlight, "to">[] = [
      { to: "review" },
      { to: "review" },
    ]
    const mid = displayLaneCounts(trueCounts, flights)
    expect(mid.get("review")).toBe(1)
    const done = displayLaneCounts(trueCounts, [])
    expect(done.get("review")).toBe(3)
  })
})

describe("countPendingArrivals", () => {
  test("counts only flights targeting the given lane", () => {
    const flights = [
      { to: "review" as const },
      { to: "pr" as const },
      { to: "review" as const },
    ]
    expect(countPendingArrivals(flights, "review")).toBe(2)
    expect(countPendingArrivals(flights, "pr")).toBe(1)
    expect(countPendingArrivals(flights, "build")).toBe(0)
  })
})

describe("laneAssignmentFromLaneItems / trueLaneCounts", () => {
  test("builds assignment and counts from lane item lists", () => {
    const laneItems = new Map(
      PIPELINE_LANES.map((lane) => [lane.id, [] as { id: string }[]]),
    )
    laneItems.set("build", [{ id: "a" }, { id: "b" }])
    laneItems.set("review", [{ id: "c" }])
    const assignmentMap = laneAssignmentFromLaneItems(laneItems)
    expect(assignmentMap.get("a")).toBe("build")
    expect(assignmentMap.get("b")).toBe("build")
    expect(assignmentMap.get("c")).toBe("review")
    const counts = trueLaneCounts(laneItems)
    expect(counts.get("build")).toBe(2)
    expect(counts.get("review")).toBe(1)
    expect(counts.get("queue")).toBe(0)
  })
})

describe("laneItemsAssignmentKey", () => {
  test("is stable across Map identity for the same id/lane pairs", () => {
    const left = new Map(
      PIPELINE_LANES.map((lane) => [lane.id, [] as { id: string }[]]),
    )
    left.set("build", [{ id: "a" }])
    left.set("review", [{ id: "b" }])
    const right = new Map(
      PIPELINE_LANES.map((lane) => [lane.id, [] as { id: string }[]]),
    )
    right.set("review", [{ id: "b" }])
    right.set("build", [{ id: "a" }])
    expect(left).not.toBe(right)
    expect(laneItemsAssignmentKey(left)).toBe(laneItemsAssignmentKey(right))
  })

  test("changes when a work item moves lane", () => {
    const before = new Map(
      PIPELINE_LANES.map((lane) => [lane.id, [] as { id: string }[]]),
    )
    before.set("build", [{ id: "a" }])
    const after = new Map(
      PIPELINE_LANES.map((lane) => [lane.id, [] as { id: string }[]]),
    )
    after.set("review", [{ id: "a" }])
    expect(laneItemsAssignmentKey(before)).not.toBe(
      laneItemsAssignmentKey(after),
    )
  })
})

describe("ROUTE_* duration constants", () => {
  test("fed and smoke durations stay aligned with the phase table", () => {
    expect(ROUTE_FED_MS).toBeGreaterThan(0)
    expect(ROUTE_SMOKE_MS).toBe(ROUTE_TRANSITION_MS.absorb)
    expect(ROUTE_TRANSITION_MS.eject).toBeGreaterThan(0)
    expect(ROUTE_TRANSITION_MS.travel).toBeGreaterThan(0)
    expect(ROUTE_TRANSITION_MS.enter).toBeGreaterThan(0)
    expect(ROUTE_TRANSITION_MS.absorb).toBeGreaterThan(0)
    expect(ROUTE_TRANSITION_TOTAL_MS).toBe(
      ROUTE_TRANSITION_MS.eject +
        ROUTE_TRANSITION_MS.travel +
        ROUTE_TRANSITION_MS.enter +
        ROUTE_TRANSITION_MS.absorb,
    )
  })
})

describe("laneCenterPercent", () => {
  test("places six stops at column midpoints", () => {
    expect(laneCenterPercent("queue")).toBeCloseTo(100 / 12)
    expect(laneCenterPercent("build")).toBeCloseTo(300 / 12)
    expect(laneCenterPercent("complete")).toBeCloseTo(1100 / 12)
  })
})

describe("nextFlightPhase / phaseDurationMs", () => {
  test("walks eject → travel → enter → absorb → done", () => {
    expect(nextFlightPhase("eject")).toBe("travel")
    expect(nextFlightPhase("travel")).toBe("enter")
    expect(nextFlightPhase("enter")).toBe("absorb")
    expect(nextFlightPhase("absorb")).toBe(null)
  })

  test("phase durations match the choreography table", () => {
    expect(phaseDurationMs("eject")).toBe(ROUTE_TRANSITION_MS.eject)
    expect(phaseDurationMs("travel")).toBe(ROUTE_TRANSITION_MS.travel)
    expect(phaseDurationMs("enter")).toBe(ROUTE_TRANSITION_MS.enter)
    expect(phaseDurationMs("absorb")).toBe(ROUTE_TRANSITION_MS.absorb)
  })
})

describe("reconcileFlights", () => {
  test("keeps flights still targeting the work item's current lane", () => {
    const flight = createRouteFlight({
      workItemId: "job-1",
      from: "build",
      to: "review",
    })
    const previous = assignment([["job-1", "build"]])
    const next = assignment([["job-1", "review"]])
    const result = reconcileFlights({
      previous,
      next,
      flights: [flight],
    })
    expect(result.flights).toHaveLength(1)
    expect(result.newTransitions).toEqual([])
  })

  test("drops flights when the work item vanishes", () => {
    const flight = createRouteFlight({
      workItemId: "job-1",
      from: "build",
      to: "review",
    })
    const result = reconcileFlights({
      previous: assignment([["job-1", "build"]]),
      next: assignment([]),
      flights: [flight],
    })
    expect(result.flights).toEqual([])
    expect(result.newTransitions).toEqual([])
  })

  test("drops stale flights and plans a new transition when lane changes mid-flight", () => {
    const flight = createRouteFlight({
      workItemId: "job-1",
      from: "build",
      to: "review",
    })
    // After the first move was detected, previous assignment already advanced
    // to review; a second live update moves the item to PR mid-flight.
    const previous = assignment([["job-1", "review"]])
    const next = assignment([["job-1", "pr"]])
    const result = reconcileFlights({
      previous,
      next,
      flights: [flight],
    })
    expect(result.flights).toEqual([])
    expect(result.newTransitions).toEqual([
      { workItemId: "job-1", from: "review", to: "pr" },
    ])
  })

  test("does not double-plan a work item already in flight to the same dest", () => {
    const flight = createRouteFlight({
      workItemId: "job-1",
      from: "build",
      to: "review",
    })
    // previous still says build so planLaneTransitions would re-emit — but
    // reconcile suppresses because a flight already covers it.
    const result = reconcileFlights({
      previous: assignment([["job-1", "build"]]),
      next: assignment([["job-1", "review"]]),
      flights: [flight],
    })
    expect(result.newTransitions).toEqual([])
  })
})
