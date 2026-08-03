import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react"
import { PIPELINE_LANES, type PipelineLaneId } from "./pipeline-lanes.js"
import {
  type FlightPhase,
  ROUTE_FED_MS,
  ROUTE_SMOKE_MS,
  ROUTE_TRANSITION_MS,
  type RouteFlight,
  assignmentsEqual,
  createRouteFlight,
  displayLaneCounts,
  laneAssignmentFromLaneItems,
  laneCenterPercent,
  laneItemsAssignmentKey,
  nextFlightPhase,
  phaseDurationMs,
  reconcileFlights,
  trueLaneCounts,
} from "./pipeline-route-transition.js"
import { cx, ui } from "./ui.js"

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !("matchMedia" in window)) {
    return false
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

type FurnacePhase = FlightPhase | "fed" | "idle"

function furnacePhaseForLane(
  laneId: PipelineLaneId,
  flights: readonly RouteFlight[],
  fedLanes: ReadonlySet<PipelineLaneId>,
): FurnacePhase {
  for (const flight of flights) {
    if (flight.from === laneId && flight.phase === "eject") return "eject"
    if (flight.to === laneId && flight.phase === "absorb") return "absorb"
  }
  if (fedLanes.has(laneId)) return "fed"
  return "idle"
}

function smokeActiveForLane(
  laneId: PipelineLaneId,
  flights: readonly RouteFlight[],
): boolean {
  for (const flight of flights) {
    if (flight.from === laneId && flight.phase === "eject") return true
    if (flight.to === laneId && flight.phase === "absorb") return true
  }
  return false
}

/** Inline furnace phase animation so durations track ROUTE_*_MS constants. */
function furnacePhaseStyle(phase: FurnacePhase): CSSProperties | undefined {
  if (phase === "eject") {
    return {
      animation: `furnace-eject ${ROUTE_TRANSITION_MS.eject}ms ease-out`,
    }
  }
  if (phase === "absorb") {
    return {
      animation: `furnace-absorb ${ROUTE_TRANSITION_MS.absorb}ms ease-out`,
    }
  }
  if (phase === "fed") {
    return {
      animation: `furnace-fed ${ROUTE_FED_MS}ms ease-out`,
    }
  }
  return undefined
}

/**
 * Desktop route line: pot-belly furnace stops with optional coal-lump traveler
 * when a work item changes pipeline lane. Presentation only — real counts come
 * from `laneItems`; destination display is delayed until absorb finishes.
 */
export function PipelineRoute({
  laneItems,
}: {
  readonly laneItems: ReadonlyMap<
    PipelineLaneId,
    readonly { readonly id: string }[]
  >
}) {
  const [flights, setFlights] = useState<readonly RouteFlight[]>([])
  const [fedLanes, setFedLanes] = useState<ReadonlySet<PipelineLaneId>>(
    () => new Set(),
  )
  const assignmentRef = useRef<Map<string, PipelineLaneId> | null>(null)
  const flightsRef = useRef(flights)
  flightsRef.current = flights
  const phaseTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  )
  const fedTimersRef = useRef(
    new Map<PipelineLaneId, ReturnType<typeof setTimeout>>(),
  )

  // Fingerprint ignores Map identity from the parent rebuilding laneItems.
  const assignmentKey = laneItemsAssignmentKey(laneItems)
  const laneSnapshotRef = useRef<{
    key: string
    assignment: Map<string, PipelineLaneId>
    counts: Map<PipelineLaneId, number>
  } | null>(null)
  if (
    laneSnapshotRef.current === null ||
    laneSnapshotRef.current.key !== assignmentKey
  ) {
    laneSnapshotRef.current = {
      key: assignmentKey,
      assignment: laneAssignmentFromLaneItems(laneItems),
      counts: trueLaneCounts(laneItems),
    }
  }
  const nextAssignment = laneSnapshotRef.current.assignment
  const trueCounts = laneSnapshotRef.current.counts

  // Seed baseline on first paint; subsequent diffs schedule travelers.
  useEffect(() => {
    if (assignmentRef.current === null) {
      assignmentRef.current = nextAssignment
      return
    }

    if (assignmentsEqual(assignmentRef.current, nextAssignment)) {
      return
    }

    if (prefersReducedMotion()) {
      assignmentRef.current = nextAssignment
      setFlights((current) => (current.length === 0 ? current : []))
      return
    }

    const { flights: kept, newTransitions } = reconcileFlights({
      previous: assignmentRef.current,
      next: nextAssignment,
      flights: flightsRef.current,
    })
    assignmentRef.current = nextAssignment

    if (newTransitions.length === 0) {
      if (kept.length !== flightsRef.current.length) {
        setFlights(kept)
      }
      return
    }

    const created = newTransitions.map(createRouteFlight)
    setFlights([...kept, ...created])
  }, [nextAssignment])

  // Advance each flight through eject → travel → enter → absorb → remove.
  useEffect(() => {
    for (const flight of flights) {
      if (phaseTimersRef.current.has(flight.id)) continue
      const scheduledPhase = flight.phase
      const timer = setTimeout(() => {
        phaseTimersRef.current.delete(flight.id)
        // Skip if reconcile cancelled the flight or phase already advanced.
        const live = flightsRef.current.find(
          (candidate) => candidate.id === flight.id,
        )
        if (live === undefined || live.phase !== scheduledPhase) return

        const next = nextFlightPhase(scheduledPhase)
        if (next === null) {
          setFlights((current) =>
            current.filter((candidate) => candidate.id !== flight.id),
          )
          setFedLanes((current) => {
            const nextSet = new Set(current)
            nextSet.add(flight.to)
            return nextSet
          })
          const existingFed = fedTimersRef.current.get(flight.to)
          if (existingFed !== undefined) clearTimeout(existingFed)
          const fedTimer = setTimeout(() => {
            fedTimersRef.current.delete(flight.to)
            setFedLanes((current) => {
              if (!current.has(flight.to)) return current
              const nextSet = new Set(current)
              nextSet.delete(flight.to)
              return nextSet
            })
          }, ROUTE_FED_MS)
          fedTimersRef.current.set(flight.to, fedTimer)
          return
        }
        setFlights((current) =>
          current.map((candidate) =>
            candidate.id === flight.id
              ? { ...candidate, phase: next }
              : candidate,
          ),
        )
      }, phaseDurationMs(scheduledPhase))
      phaseTimersRef.current.set(flight.id, timer)
    }

    // Drop timers for flights that were cancelled/reconciled away.
    for (const [flightId, timer] of phaseTimersRef.current) {
      if (flights.some((flight) => flight.id === flightId)) continue
      clearTimeout(timer)
      phaseTimersRef.current.delete(flightId)
    }
  }, [flights])

  useEffect(() => {
    return () => {
      for (const timer of phaseTimersRef.current.values()) clearTimeout(timer)
      phaseTimersRef.current.clear()
      for (const timer of fedTimersRef.current.values()) clearTimeout(timer)
      fedTimersRef.current.clear()
    }
  }, [])

  const displayCounts = useMemo(
    () => displayLaneCounts(trueCounts, flights),
    [trueCounts, flights],
  )

  return (
    <div className={ui.pipelineRoute}>
      {PIPELINE_LANES.map((lane) => {
        const count = displayCounts.get(lane.id) ?? 0
        const phase = furnacePhaseForLane(lane.id, flights, fedLanes)
        const smokeActive = smokeActiveForLane(lane.id, flights)
        const phaseMotion = furnacePhaseStyle(phase)
        return (
          <span
            className={ui.laneRoundel}
            data-lane={lane.id}
            data-phase={phase === "idle" ? undefined : phase}
            key={lane.id}
            role="img"
            aria-label={`${count} jobs in ${lane.label}`}
            style={
              {
                "--lane-color": lane.color,
                "--lane-text": lane.text,
                ...phaseMotion,
              } as CSSProperties
            }
          >
            <span className={ui.laneFurnaceStack} aria-hidden="true" />
            <span
              className={ui.laneFurnaceBody}
              data-lane={lane.id}
              aria-hidden="true"
            >
              <span className={ui.laneFurnaceCount}>{count}</span>
              <span className={ui.laneFurnaceMouth} />
              <span
                className={ui.laneFurnaceGlow}
                data-lit={count > 0 ? "true" : "false"}
              />
            </span>
            <span
              className={ui.laneFurnaceSmoke}
              data-active={smokeActive ? "true" : "false"}
              aria-hidden="true"
              style={
                smokeActive
                  ? {
                      animation: `furnace-smoke ${ROUTE_SMOKE_MS}ms ease-out forwards`,
                    }
                  : undefined
              }
            >
              <span className={ui.laneFurnaceSmokePuff} aria-hidden="true" />
              <span className={ui.laneFurnaceSmokePuffAlt} aria-hidden="true" />
            </span>
          </span>
        )
      })}
      {flights.map((flight) => (
        <RouteTraveler key={flight.id} flight={flight} />
      ))}
    </div>
  )
}

function RouteTraveler({ flight }: { readonly flight: RouteFlight }) {
  const from = laneCenterPercent(flight.from)
  const to = laneCenterPercent(flight.to)
  const style: CSSProperties & Record<string, string | number> = {
    "--travel-from": `${from}%`,
    "--travel-to": `${to}%`,
  }

  if (flight.phase === "eject") {
    style.left = `${from}%`
    style.animation = `route-traveler-eject ${ROUTE_TRANSITION_MS.eject}ms ease-out forwards`
  } else if (flight.phase === "travel") {
    style.left = `${from}%`
    style.animation = `route-travel ${ROUTE_TRANSITION_MS.travel}ms ease-in-out forwards`
  } else if (flight.phase === "enter") {
    style.left = `${to}%`
    style.animation = `route-traveler-enter ${ROUTE_TRANSITION_MS.enter}ms ease-in forwards`
  } else {
    // Absorb: traveler already swallowed; hide.
    style.left = `${to}%`
    style.opacity = 0
  }

  return (
    <span
      className={cx(ui.routeTraveler)}
      style={style}
      aria-hidden="true"
      data-phase={flight.phase}
      data-from={flight.from}
      data-to={flight.to}
    />
  )
}
