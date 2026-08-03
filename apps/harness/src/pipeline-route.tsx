import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react"
import { PIPELINE_LANES, type PipelineLaneId } from "./pipeline-lanes.js"
import {
  type FlightPhase,
  ROUTE_FED_MS,
  ROUTE_TRANSITION_MS,
  type RouteFlight,
  assignmentsEqual,
  createRouteFlight,
  displayLaneCounts,
  furnaceFireLit,
  laneAssignmentFromLaneItems,
  laneCenterPercent,
  laneItemsAssignmentKey,
  nextFlightPhase,
  phaseDurationMs,
  reconcileFlights,
  smokeDurationMs,
  sourceOrderIndexInLane,
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

type SmokeKind = "eject" | "absorb"

type LingeringSmoke = {
  readonly kind: SmokeKind
  readonly key: string
  readonly smokeMs: number
}

/** Inline furnace phase animation so durations track ROUTE_*_MS constants. */
function furnacePhaseStyle(phase: FurnacePhase): CSSProperties | undefined {
  if (phase === "eject") {
    return {
      animation: `furnace-eject ${ROUTE_TRANSITION_MS.eject}ms cubic-bezier(0.4, 0, 0.2, 1)`,
    }
  }
  if (phase === "absorb") {
    return {
      animation: `furnace-absorb ${ROUTE_TRANSITION_MS.absorb}ms cubic-bezier(0.4, 0, 0.2, 1)`,
    }
  }
  if (phase === "fed") {
    return {
      animation: `furnace-fed ${ROUTE_FED_MS}ms ease-out`,
    }
  }
  return undefined
}

function orderedIdsByLaneFromItems(
  laneItems: ReadonlyMap<PipelineLaneId, readonly { readonly id: string }[]>,
): Map<PipelineLaneId, readonly string[]> {
  const ordered = new Map<PipelineLaneId, readonly string[]>()
  for (const lane of PIPELINE_LANES) {
    ordered.set(
      lane.id,
      (laneItems.get(lane.id) ?? []).map((item) => item.id),
    )
  }
  return ordered
}

export type PipelineRouteFlights = {
  readonly flights: readonly RouteFlight[]
  readonly fedLanes: ReadonlySet<PipelineLaneId>
  readonly displayCounts: ReadonlyMap<PipelineLaneId, number>
}

/**
 * Own route-line flight state from true lane assignment. Shared by the route
 * chrome and the board so furnace counts, greyed departing tickets, and the
 * absorb-arrival fade stay aligned with travelers.
 */
export function usePipelineRouteFlights(
  laneItems: ReadonlyMap<PipelineLaneId, readonly { readonly id: string }[]>,
): PipelineRouteFlights {
  const [flights, setFlights] = useState<readonly RouteFlight[]>([])
  const [fedLanes, setFedLanes] = useState<ReadonlySet<PipelineLaneId>>(
    () => new Set(),
  )
  const assignmentRef = useRef<Map<string, PipelineLaneId> | null>(null)
  /** Source-lane id order from the last committed assignment (pre-move). */
  const orderedIdsByLaneRef = useRef<Map<PipelineLaneId, readonly string[]>>(
    orderedIdsByLaneFromItems(laneItems),
  )
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
    orderedIdsByLane: Map<PipelineLaneId, readonly string[]>
  } | null>(null)
  if (
    laneSnapshotRef.current === null ||
    laneSnapshotRef.current.key !== assignmentKey
  ) {
    laneSnapshotRef.current = {
      key: assignmentKey,
      assignment: laneAssignmentFromLaneItems(laneItems),
      counts: trueLaneCounts(laneItems),
      orderedIdsByLane: orderedIdsByLaneFromItems(laneItems),
    }
  }
  const nextAssignment = laneSnapshotRef.current.assignment
  const trueCounts = laneSnapshotRef.current.counts
  const nextOrderedIds = laneSnapshotRef.current.orderedIdsByLane

  // Seed baseline on first paint; subsequent diffs schedule travelers.
  useEffect(() => {
    if (assignmentRef.current === null) {
      assignmentRef.current = nextAssignment
      orderedIdsByLaneRef.current = nextOrderedIds
      return
    }

    if (assignmentsEqual(assignmentRef.current, nextAssignment)) {
      orderedIdsByLaneRef.current = nextOrderedIds
      return
    }

    if (prefersReducedMotion()) {
      assignmentRef.current = nextAssignment
      orderedIdsByLaneRef.current = nextOrderedIds
      setFlights((current) => (current.length === 0 ? current : []))
      return
    }

    // Snapshot source order *before* advancing the assignment — that is the
    // pre-move stack position for greying cards mid-column.
    const priorOrder = orderedIdsByLaneRef.current
    const { flights: kept, newTransitions } = reconcileFlights({
      previous: assignmentRef.current,
      next: nextAssignment,
      flights: flightsRef.current,
    })
    assignmentRef.current = nextAssignment
    orderedIdsByLaneRef.current = nextOrderedIds

    if (newTransitions.length === 0) {
      if (kept.length !== flightsRef.current.length) {
        setFlights(kept)
      }
      return
    }

    const created = newTransitions.map((transition) =>
      createRouteFlight(
        transition,
        sourceOrderIndexInLane({
          workItemId: transition.workItemId,
          laneId: transition.from,
          orderedIdsByLane: priorOrder,
        }),
      ),
    )
    setFlights([...kept, ...created])
  }, [nextAssignment, nextOrderedIds])

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

  return { flights, fedLanes, displayCounts }
}

/**
 * Active smoke triggers for the current flight phase (start of plume only).
 * Lingering is handled by `useLingeringSmoke` so the DOM stays mounted for
 * the full smokeDurationMs.
 */
function activeSmokeTriggers(
  flights: readonly RouteFlight[],
): readonly { laneId: PipelineLaneId; kind: SmokeKind; key: string }[] {
  const triggers: { laneId: PipelineLaneId; kind: SmokeKind; key: string }[] =
    []
  for (const flight of flights) {
    if (flight.phase === "eject") {
      triggers.push({
        laneId: flight.from,
        kind: "eject",
        key: `${flight.id}:eject`,
      })
    } else if (flight.phase === "absorb") {
      triggers.push({
        laneId: flight.to,
        kind: "absorb",
        key: `${flight.id}:absorb`,
      })
    }
  }
  return triggers
}

/**
 * Keep smoke mounted for its full smokeMs even after the flight leaves
 * eject/absorb, so plumes are not cut short by phase transitions.
 */
function useLingeringSmoke(
  flights: readonly RouteFlight[],
): ReadonlyMap<PipelineLaneId, LingeringSmoke> {
  const [smokeByLane, setSmokeByLane] = useState(
    () => new Map<PipelineLaneId, LingeringSmoke>(),
  )
  const timersRef = useRef(
    new Map<PipelineLaneId, ReturnType<typeof setTimeout>>(),
  )

  useEffect(() => {
    const triggers = activeSmokeTriggers(flights)
    for (const trigger of triggers) {
      setSmokeByLane((current) => {
        const existing = current.get(trigger.laneId)
        if (existing?.key === trigger.key) return current
        const smokeMs = smokeDurationMs(trigger.kind)
        const next = new Map(current)
        next.set(trigger.laneId, {
          kind: trigger.kind,
          key: trigger.key,
          smokeMs,
        })
        const priorTimer = timersRef.current.get(trigger.laneId)
        if (priorTimer !== undefined) clearTimeout(priorTimer)
        const laneId = trigger.laneId
        const key = trigger.key
        timersRef.current.set(
          laneId,
          setTimeout(() => {
            timersRef.current.delete(laneId)
            setSmokeByLane((prev) => {
              const live = prev.get(laneId)
              if (live === undefined || live.key !== key) return prev
              const copy = new Map(prev)
              copy.delete(laneId)
              return copy
            })
          }, smokeMs),
        )
        return next
      })
    }
  }, [flights])

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [])

  return smokeByLane
}

/**
 * Desktop route line: pot-belly furnace stops with optional coal-lump traveler
 * when a work item changes pipeline lane. Presentation only — real counts come
 * from the board’s work-item data; display counts stay delayed through
 * pre-absorb phases and catch up when the flight enters absorb.
 */
export function PipelineRoute({
  flights,
  fedLanes,
  displayCounts,
}: {
  readonly flights: readonly RouteFlight[]
  readonly fedLanes: ReadonlySet<PipelineLaneId>
  readonly displayCounts: ReadonlyMap<PipelineLaneId, number>
}) {
  const lingeringSmoke = useLingeringSmoke(flights)

  return (
    <div className={ui.pipelineRoute}>
      <div className={ui.pipelineRouteSpine} aria-hidden="true">
        <span className={ui.pipelineRouteSpineBore} />
        <span className={ui.pipelineRouteSpineRivets} />
      </div>
      {PIPELINE_LANES.map((lane) => {
        const count = displayCounts.get(lane.id) ?? 0
        const phase = furnacePhaseForLane(lane.id, flights, fedLanes)
        const phaseMotion = furnacePhaseStyle(phase)
        const fireLit = furnaceFireLit(lane.id, count)
        const smoke = lingeringSmoke.get(lane.id)
        return (
          <span
            className={ui.laneRoundel}
            data-lane={lane.id}
            data-phase={phase === "idle" ? undefined : phase}
            data-lit={fireLit ? "true" : "false"}
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
              <span className={ui.laneFurnaceBand} aria-hidden="true" />
              <span
                className={ui.laneFurnaceGlow}
                data-lit={fireLit ? "true" : "false"}
              />
              <span className={ui.laneFurnaceCount}>{count}</span>
              <span className={ui.laneFurnaceMouth} aria-hidden="true">
                <span
                  className={ui.laneFurnaceFire}
                  data-lit={fireLit ? "true" : "false"}
                >
                  <span
                    className={ui.laneFurnaceEmber}
                    data-lit={fireLit ? "true" : "false"}
                  />
                  <span
                    className={ui.laneFurnaceFlame}
                    data-lit={fireLit ? "true" : "false"}
                    data-i="0"
                  />
                  <span
                    className={ui.laneFurnaceFlame}
                    data-lit={fireLit ? "true" : "false"}
                    data-i="1"
                  />
                  <span
                    className={ui.laneFurnaceFlame}
                    data-lit={fireLit ? "true" : "false"}
                    data-i="2"
                  />
                </span>
              </span>
            </span>
            {smoke !== undefined ? (
              <FurnaceSmoke
                key={smoke.key}
                kind={smoke.kind}
                smokeMs={smoke.smokeMs}
              />
            ) : null}
          </span>
        )
      })}
      {flights.map((flight) => (
        <RouteTraveler key={flight.id} flight={flight} />
      ))}
    </div>
  )
}

function FurnaceSmoke({
  kind,
  smokeMs,
}: {
  readonly kind: SmokeKind
  readonly smokeMs: number
}) {
  return (
    <span
      className={ui.laneFurnaceSmoke}
      data-kind={kind}
      aria-hidden="true"
      style={{ ["--smoke-ms" as string]: `${smokeMs}ms` }}
    >
      <span className={ui.laneFurnaceSmokePuff} data-i="0" />
      <span className={ui.laneFurnaceSmokePuff} data-i="1" />
      <span className={ui.laneFurnaceSmokePuff} data-i="2" />
      <span className={ui.laneFurnaceSmokePuff} data-i="3" />
      <span className={ui.laneFurnaceSmokePuff} data-i="4" />
    </span>
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
    // Scale/opacity only — rotation lives solely on travel so phases do not snap.
    style.animation = `route-traveler-eject ${ROUTE_TRANSITION_MS.eject}ms cubic-bezier(0.2, 0.85, 0.3, 1.1) forwards`
  } else if (flight.phase === "travel") {
    style.left = `${from}%`
    style.animation = `route-travel ${ROUTE_TRANSITION_MS.travel}ms cubic-bezier(0.45, 0.05, 0.25, 1) forwards`
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
