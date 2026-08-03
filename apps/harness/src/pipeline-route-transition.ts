import { PIPELINE_LANES, type PipelineLaneId } from "./pipeline-lanes.js"

/** Work-item id → current pipeline lane. */
export type LaneAssignment = ReadonlyMap<string, PipelineLaneId>

export type PlannedTransition = {
  readonly workItemId: string
  readonly from: PipelineLaneId
  readonly to: PipelineLaneId
}

/**
 * Phases of a route-line furnace handoff. Destination display count stays
 * delayed until the flight is removed after `absorb` finishes.
 */
export type FlightPhase = "eject" | "travel" | "enter" | "absorb"

export type RouteFlight = {
  readonly id: string
  readonly workItemId: string
  readonly from: PipelineLaneId
  readonly to: PipelineLaneId
  readonly phase: FlightPhase
  /**
   * Index of the work item in the source lane’s order at departure time.
   * Used so the greyed card stays mid-stack instead of jumping to the end.
   */
  readonly sourceOrderIndex: number
}

/**
 * Choreography durations (ms). Intentionally unhurried (~3.9s total) so the
 * furnace handoff reads on a real board. Concurrent mid-flight replans cancel
 * and restart from the new edge — expected cost of the slower timing.
 *
 *   eject 700 + travel 1600 + enter 400 + absorb 1200 = 3900 ms
 */
export const ROUTE_TRANSITION_MS = {
  eject: 700,
  travel: 1600,
  enter: 400,
  absorb: 1200,
} as const satisfies Record<FlightPhase, number>

/** Brief post-absorb “fed” glow on the destination furnace. */
export const ROUTE_FED_MS = 500

/**
 * Stack smoke duration (ms). Plume is timer-driven and may outlast the
 * eject/absorb phase so puffs finish rising after the furnace settles.
 * Eject uses a shorter burst (see smokeDurationMs).
 */
export const ROUTE_SMOKE_MS = 1400

export const ROUTE_TRANSITION_TOTAL_MS =
  ROUTE_TRANSITION_MS.eject +
  ROUTE_TRANSITION_MS.travel +
  ROUTE_TRANSITION_MS.enter +
  ROUTE_TRANSITION_MS.absorb

/** Smoke wall-clock for a given kind (decoupled from phase unmount). */
export function smokeDurationMs(kind: "eject" | "absorb"): number {
  return kind === "eject"
    ? Math.min(ROUTE_SMOKE_MS, ROUTE_TRANSITION_MS.eject + 200)
    : ROUTE_SMOKE_MS
}

/**
 * Fire lights only on the four active pipeline furnaces when occupied.
 * Attention (holding pen) and Merged/`complete` stay cold even when they hold
 * tickets. Shared so UI and tests agree.
 */
export function furnaceFireLit(laneId: PipelineLaneId, count: number): boolean {
  return count > 0 && laneId !== "attention" && laneId !== "complete"
}

const LANE_INDEX = new Map<PipelineLaneId, number>(
  PIPELINE_LANES.map((lane, index) => [lane.id, index]),
)

/** Content equality for work-item → lane maps (ignores Map identity). */
export function assignmentsEqual(
  left: LaneAssignment,
  right: LaneAssignment,
): boolean {
  if (left.size !== right.size) return false
  for (const [workItemId, lane] of left) {
    if (right.get(workItemId) !== lane) return false
  }
  return true
}

/**
 * Diff previous vs next work-item lane maps. Only items present in both with a
 * changed lane become transitions. Appearances and disappearances are silent
 * (counts snap with the data — no traveler).
 */
export function planLaneTransitions(
  previous: LaneAssignment,
  next: LaneAssignment,
): readonly PlannedTransition[] {
  const planned: PlannedTransition[] = []
  for (const [workItemId, to] of next) {
    const from = previous.get(workItemId)
    if (from === undefined || from === to) continue
    planned.push({ workItemId, from, to })
  }
  return planned
}

/**
 * Build a work-item → lane map from per-lane item lists (kanban board shape).
 */
export function laneAssignmentFromLaneItems(
  laneItems: ReadonlyMap<PipelineLaneId, readonly { readonly id: string }[]>,
): Map<string, PipelineLaneId> {
  const assignment = new Map<string, PipelineLaneId>()
  for (const [laneId, items] of laneItems) {
    for (const item of items) {
      assignment.set(item.id, laneId)
    }
  }
  return assignment
}

/**
 * Stable content fingerprint for lane item lists (ids + lanes). Ignores Map
 * identity so React memos/effects do not thrash when the parent rebuilds Maps.
 */
export function laneItemsAssignmentKey(
  laneItems: ReadonlyMap<PipelineLaneId, readonly { readonly id: string }[]>,
): string {
  const parts: string[] = []
  for (const [laneId, items] of laneItems) {
    for (const item of items) {
      parts.push(`${item.id}:${laneId}`)
    }
  }
  parts.sort()
  return parts.join("|")
}

/**
 * True per-lane counts from lane item lists.
 */
export function trueLaneCounts(
  laneItems: ReadonlyMap<PipelineLaneId, readonly unknown[]>,
): Map<PipelineLaneId, number> {
  const counts = new Map<PipelineLaneId, number>()
  for (const lane of PIPELINE_LANES) {
    counts.set(lane.id, laneItems.get(lane.id)?.length ?? 0)
  }
  return counts
}

/**
 * How many in-flight travelers are still waiting to be absorbed into `lane`.
 * While a flight is active its work item already lives in `to` in real data,
 * so the destination display must subtract these until absorb completes.
 */
export function countPendingArrivals(
  flights: readonly Pick<RouteFlight, "to">[],
  lane: PipelineLaneId,
): number {
  let count = 0
  for (const flight of flights) {
    if (flight.to === lane) count += 1
  }
  return count
}

/**
 * Presentation count for one stop. Never negative.
 *
 * - Destination stays flat until absorb (subtract pending arrivals).
 * - Source keeps the departing job until the flight ends (add pending
 *   departures) so furnace counts match greyed-out cards still in the lane.
 */
export function displayLaneCount(args: {
  readonly trueCount: number
  readonly pendingArrivals: number
  readonly pendingDepartures?: number
}): number {
  return Math.max(
    0,
    args.trueCount - args.pendingArrivals + (args.pendingDepartures ?? 0),
  )
}

/**
 * Display counts for every pipeline lane given true counts and active flights.
 */
export function displayLaneCounts(
  trueCounts: ReadonlyMap<PipelineLaneId, number>,
  flights: readonly Pick<RouteFlight, "from" | "to">[],
): Map<PipelineLaneId, number> {
  const pendingArrivals = new Map<PipelineLaneId, number>()
  const pendingDepartures = new Map<PipelineLaneId, number>()
  for (const flight of flights) {
    pendingArrivals.set(flight.to, (pendingArrivals.get(flight.to) ?? 0) + 1)
    pendingDepartures.set(
      flight.from,
      (pendingDepartures.get(flight.from) ?? 0) + 1,
    )
  }
  const display = new Map<PipelineLaneId, number>()
  for (const lane of PIPELINE_LANES) {
    const trueCount = trueCounts.get(lane.id) ?? 0
    display.set(
      lane.id,
      displayLaneCount({
        trueCount,
        pendingArrivals: pendingArrivals.get(lane.id) ?? 0,
        pendingDepartures: pendingDepartures.get(lane.id) ?? 0,
      }),
    )
  }
  return display
}

/**
 * Tickets to render in a lane column during route flights.
 *
 * Real data already places a moved job in the destination lane. Presentation:
 * - Keep it in the **source** lane while in flight (greyed “departing”),
 *   inserted at `sourceOrderIndex` so mid-stack cards do not jump to the end.
 * - Hold it out of the **destination** lane until absorb finishes.
 */
export function presentLaneColumnItems<
  T extends { readonly id: string },
>(args: {
  readonly laneId: PipelineLaneId
  readonly laneItems: readonly T[]
  readonly flights: readonly Pick<
    RouteFlight,
    "workItemId" | "from" | "to" | "sourceOrderIndex"
  >[]
  readonly workItemById: ReadonlyMap<string, T>
}): readonly { readonly workItem: T; readonly departing: boolean }[] {
  const departing: {
    workItemId: string
    sourceOrderIndex: number
  }[] = []
  const arrivingIds = new Set<string>()
  for (const flight of args.flights) {
    if (flight.from === args.laneId) {
      departing.push({
        workItemId: flight.workItemId,
        sourceOrderIndex: flight.sourceOrderIndex,
      })
    }
    if (flight.to === args.laneId) arrivingIds.add(flight.workItemId)
  }

  const residents: { workItem: T; departing: boolean }[] = []
  for (const item of args.laneItems) {
    if (arrivingIds.has(item.id)) continue
    residents.push({ workItem: item, departing: false })
  }

  // Insert greys at frozen source indices (stable mid-stack, not append-only).
  const result = [...residents]
  const seen = new Set(result.map((entry) => entry.workItem.id))
  const sortedDeparting = departing
    .slice()
    .sort((left, right) => left.sourceOrderIndex - right.sourceOrderIndex)

  for (const { workItemId, sourceOrderIndex } of sortedDeparting) {
    if (seen.has(workItemId)) continue
    const workItem = args.workItemById.get(workItemId)
    if (workItem === undefined) continue
    const insertAt = Math.min(Math.max(0, sourceOrderIndex), result.length)
    result.splice(insertAt, 0, { workItem, departing: true })
    seen.add(workItemId)
  }

  return result
}

/**
 * Horizontal center of a stop on the six-column route, as a percentage of the
 * route width (matches CSS grid column midpoints).
 */
export function laneCenterPercent(laneId: PipelineLaneId): number {
  const index = LANE_INDEX.get(laneId)
  if (index === undefined) return 0
  return ((index + 0.5) / PIPELINE_LANES.length) * 100
}

/**
 * Advance a flight to the next phase, or `null` when absorb is done and the
 * flight should be removed (destination count may then catch up).
 */
export function nextFlightPhase(phase: FlightPhase): FlightPhase | null {
  switch (phase) {
    case "eject":
      return "travel"
    case "travel":
      return "enter"
    case "enter":
      return "absorb"
    case "absorb":
      return null
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}

/** Duration of the current phase in ms. */
export function phaseDurationMs(phase: FlightPhase): number {
  return ROUTE_TRANSITION_MS[phase]
}

/**
 * Reconcile in-flight travelers with the latest assignment.
 *
 * - Drop flights whose work item vanished or already sits somewhere other than
 *   the flight destination (mid-flight replan would be wrong to keep).
 * - Return planned transitions for new lane changes, skipping work items that
 *   already have an active flight to the same destination.
 */
export function reconcileFlights(args: {
  readonly previous: LaneAssignment
  readonly next: LaneAssignment
  readonly flights: readonly RouteFlight[]
}): {
  readonly flights: readonly RouteFlight[]
  readonly newTransitions: readonly PlannedTransition[]
} {
  const kept: RouteFlight[] = []
  const activeWorkItems = new Set<string>()
  for (const flight of args.flights) {
    const current = args.next.get(flight.workItemId)
    if (current === undefined) continue
    if (current !== flight.to) continue
    kept.push(flight)
    activeWorkItems.add(flight.workItemId)
  }

  const planned = planLaneTransitions(args.previous, args.next)
  const newTransitions = planned.filter(
    (transition) => !activeWorkItems.has(transition.workItemId),
  )

  return { flights: kept, newTransitions }
}

let flightSeq = 0

/** Stable-enough unique id for a route flight (client-only presentation). */
function createFlightId(workItemId: string): string {
  flightSeq += 1
  return `route-flight-${flightSeq}-${workItemId}`
}

export function createRouteFlight(
  transition: PlannedTransition,
  sourceOrderIndex = 0,
): RouteFlight {
  return {
    id: createFlightId(transition.workItemId),
    workItemId: transition.workItemId,
    from: transition.from,
    to: transition.to,
    phase: "eject",
    sourceOrderIndex: Math.max(0, sourceOrderIndex),
  }
}

/**
 * Index of `workItemId` among items assigned to `lane` in a prior ordered
 * id list (source lane snapshot at departure). Falls back to 0.
 */
export function sourceOrderIndexInLane(args: {
  readonly workItemId: string
  readonly laneId: PipelineLaneId
  readonly orderedIdsByLane: ReadonlyMap<PipelineLaneId, readonly string[]>
}): number {
  const order = args.orderedIdsByLane.get(args.laneId)
  if (order === undefined) return 0
  const index = order.indexOf(args.workItemId)
  return index < 0 ? 0 : index
}
