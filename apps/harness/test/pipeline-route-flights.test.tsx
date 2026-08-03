/**
 * Regression: first paint after a lane assignment change must already show the
 * departing ticket / route traveler (issue #760). Uses flushSync so layout
 * effects run but passive effects do not — a useEffect-based reconciliation
 * would still leave the destination ticket visible after the flush.
 */
import { Window } from "happy-dom"
import {
  type ReactElement,
  createElement,
  useLayoutEffect,
  useState,
} from "react"
import { flushSync } from "react-dom"
import { type Root, createRoot } from "react-dom/client"
import { PIPELINE_LANES, type PipelineLaneId } from "../src/pipeline-lanes.js"
import { usePipelineRouteFlights } from "../src/pipeline-route.js"
import {
  displayLaneCounts,
  presentLaneColumnItems,
  trueLaneCounts,
} from "../src/pipeline-route-transition.js"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

type LaneItem = { readonly id: string }

type FrameSnapshot = {
  readonly flights: readonly {
    readonly workItemId: string
    readonly from: PipelineLaneId
    readonly to: PipelineLaneId
    readonly phase: string
  }[]
  readonly build: readonly {
    readonly id: string
    readonly departing: boolean
    readonly arriving: boolean
  }[]
  readonly review: readonly {
    readonly id: string
    readonly departing: boolean
    readonly arriving: boolean
  }[]
  readonly displayCounts: Readonly<Record<string, number>>
}

/** Keys this suite installs on globalThis for React-DOM + happy-dom. */
const INSTALLED_GLOBAL_KEYS = [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "DocumentFragment",
  "SVGElement",
  "navigator",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
  "IS_REACT_ACT_ENVIRONMENT",
] as const

type GlobalSnapshot = ReadonlyMap<
  string,
  { readonly had: boolean; readonly value: unknown }
>

function emptyLaneItems(): Map<PipelineLaneId, readonly LaneItem[]> {
  return new Map(PIPELINE_LANES.map((lane) => [lane.id, [] as LaneItem[]]))
}

function snapshotGlobals(keys: readonly string[]): GlobalSnapshot {
  const g = globalThis as unknown as Record<string, unknown>
  const snap = new Map<
    string,
    { readonly had: boolean; readonly value: unknown }
  >()
  for (const key of keys) {
    snap.set(key, {
      had: Object.hasOwn(g, key),
      value: g[key],
    })
  }
  return snap
}

function restoreGlobals(snap: GlobalSnapshot): void {
  const g = globalThis as unknown as Record<string, unknown>
  for (const [key, entry] of snap) {
    if (entry.had) {
      g[key] = entry.value
    } else {
      delete g[key]
    }
  }
}

/** Assign onto globalThis without fighting happy-dom vs lib.dom structural types. */
function setGlobal(key: string, value: unknown): void {
  ;(globalThis as unknown as Record<string, unknown>)[key] = value
}

type InstalledDom = {
  readonly window: Window
  /** Close happy-dom and restore prior globalThis keys. */
  readonly dispose: () => void
}

function installDom(args?: { readonly reducedMotion?: boolean }): InstalledDom {
  const previous = snapshotGlobals(INSTALLED_GLOBAL_KEYS)
  const happyWindow = new Window({ url: "https://localhost/" })
  const reducedMotion = args?.reducedMotion ?? false
  happyWindow.matchMedia = ((query: string) => {
    const matches =
      reducedMotion &&
      String(query).includes("prefers-reduced-motion") &&
      String(query).includes("reduce")
    return {
      matches,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false
      },
    }
  }) as unknown as typeof happyWindow.matchMedia

  // Bridge happy-dom constructors/APIs into the globals React-DOM expects.
  setGlobal("window", happyWindow)
  setGlobal("document", happyWindow.document)
  setGlobal("HTMLElement", happyWindow.HTMLElement)
  setGlobal("Element", happyWindow.Element)
  setGlobal("Node", happyWindow.Node)
  setGlobal("DocumentFragment", happyWindow.DocumentFragment)
  setGlobal("SVGElement", happyWindow.SVGElement)
  setGlobal("navigator", happyWindow.navigator)
  setGlobal("getComputedStyle", happyWindow.getComputedStyle.bind(happyWindow))
  const rafTimers = new Map<number, ReturnType<typeof setTimeout>>()
  let rafSeq = 0
  setGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafSeq += 1
    const id = rafSeq
    const timer = setTimeout(() => {
      rafTimers.delete(id)
      cb(Date.now())
    }, 0)
    rafTimers.set(id, timer)
    return id
  })
  setGlobal("cancelAnimationFrame", (id: number) => {
    const timer = rafTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      rafTimers.delete(id)
    }
  })
  setGlobal("MutationObserver", happyWindow.MutationObserver)
  // Intentionally false: we use flushSync (not act) so layout effects run while
  // passive effects stay pending — the seam that catches a useEffect regression.
  setGlobal("IS_REACT_ACT_ENVIRONMENT", false)

  let disposed = false
  return {
    window: happyWindow,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const timer of rafTimers.values()) clearTimeout(timer)
      rafTimers.clear()
      happyWindow.close()
      restoreGlobals(previous)
    },
  }
}

/** happy-dom element → DOM HTMLElement for React createRoot / queries. */
function asDomElement(node: unknown): HTMLElement {
  return node as unknown as HTMLElement
}

function mountRootContainer(happyWindow: Window): HTMLElement {
  const el = happyWindow.document.createElement("div")
  happyWindow.document.body.appendChild(el)
  return asDomElement(el)
}

/**
 * Latest committed presentation after layout effects. Overwrites on each
 * layout pass so intermediate empty-flight frames during setFlights flush are
 * discarded — only the last frame of a flushSync is authoritative.
 */
type FrameHolder = { current: FrameSnapshot | null }

function BoardProbe({
  laneItems,
  onFrame,
}: {
  readonly laneItems: ReadonlyMap<PipelineLaneId, readonly LaneItem[]>
  readonly onFrame: (frame: FrameSnapshot) => void
}): ReactElement {
  const route = usePipelineRouteFlights(laneItems)
  const workItemById = new Map<string, LaneItem>()
  for (const items of laneItems.values()) {
    for (const item of items) {
      workItemById.set(item.id, item)
    }
  }

  // Publish after layout effects of children (this probe) so the snapshot is
  // the post-reconciliation commit — the first paint opportunity.
  useLayoutEffect(() => {
    const build = presentLaneColumnItems({
      laneId: "build",
      laneItems: laneItems.get("build") ?? [],
      flights: route.flights,
      workItemById,
    }).map((entry) => ({
      id: entry.workItem.id,
      departing: entry.departing,
      arriving: entry.arriving,
    }))
    const review = presentLaneColumnItems({
      laneId: "review",
      laneItems: laneItems.get("review") ?? [],
      flights: route.flights,
      workItemById,
    }).map((entry) => ({
      id: entry.workItem.id,
      departing: entry.departing,
      arriving: entry.arriving,
    }))
    const counts = displayLaneCounts(trueLaneCounts(laneItems), route.flights)
    const displayCounts: Record<string, number> = {}
    for (const lane of PIPELINE_LANES) {
      displayCounts[lane.id] = counts.get(lane.id) ?? 0
    }
    onFrame({
      flights: route.flights.map((flight) => ({
        workItemId: flight.workItemId,
        from: flight.from,
        to: flight.to,
        phase: flight.phase,
      })),
      build,
      review,
      displayCounts,
    })
  })

  return createElement("div", {
    "data-flight-count": String(route.flights.length),
    "data-flight-phase": route.flights[0]?.phase ?? "",
    "data-build-ids": (laneItems.get("build") ?? []).map((i) => i.id).join(","),
    "data-review-ids": (laneItems.get("review") ?? [])
      .map((i) => i.id)
      .join(","),
  })
}

function Harness({
  initial,
  onFrame,
  controlRef,
}: {
  readonly initial: Map<PipelineLaneId, readonly LaneItem[]>
  readonly onFrame: (frame: FrameSnapshot) => void
  readonly controlRef: {
    current: null | {
      setLaneItems: (next: Map<PipelineLaneId, readonly LaneItem[]>) => void
    }
  }
}): ReactElement {
  const [laneItems, setLaneItems] = useState(initial)
  useLayoutEffect(() => {
    controlRef.current = { setLaneItems }
  })
  return createElement(BoardProbe, { laneItems, onFrame })
}

describe("usePipelineRouteFlights first paint", () => {
  let installed: InstalledDom
  let root: Root | null = null
  let container: HTMLElement

  /** Unmount React then let its scheduler drain while happy-dom window still exists. */
  async function tearDownRoot(): Promise<void> {
    if (root !== null) {
      flushSync(() => {
        root?.unmount()
      })
      root = null
    }
    // React may schedule a NormalPriority callback that reads `window.event`.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  }

  beforeEach(() => {
    installed = installDom()
    container = mountRootContainer(installed.window)
    root = createRoot(container)
  })

  afterEach(async () => {
    await tearDownRoot()
    installed.dispose()
  })

  test("first paint after lane change keeps departing ticket and withholds destination", () => {
    // Holder overwrites each layout pass; after flushSync it is the paint frame.
    const frame: FrameHolder = { current: null }
    const controlRef: {
      current: null | {
        setLaneItems: (next: Map<PipelineLaneId, readonly LaneItem[]>) => void
      }
    } = { current: null }

    const buildOnly = emptyLaneItems()
    buildOnly.set("build", [{ id: "job-1" }, { id: "job-2" }])

    flushSync(() => {
      root?.render(
        createElement(Harness, {
          initial: buildOnly,
          onFrame: (next) => {
            frame.current = next
          },
          controlRef,
        }),
      )
    })

    // Baseline settled: no invented flights on load.
    expect(controlRef.current).not.toBeNull()
    const baseline = frame.current
    expect(baseline).not.toBeNull()
    expect(baseline?.flights).toEqual([])
    expect(baseline?.build).toEqual([
      { id: "job-1", departing: false, arriving: false },
      { id: "job-2", departing: false, arriving: false },
    ])
    expect(baseline?.review).toEqual([])
    expect(baseline?.displayCounts.build).toBe(2)
    expect(baseline?.displayCounts.review).toBe(0)

    // Authoritative data: job-1 classifies into Review (true counts move).
    const afterMove = emptyLaneItems()
    afterMove.set("build", [{ id: "job-2" }])
    afterMove.set("review", [{ id: "job-1" }])

    // flushSync runs layout effects only — passive effects stay pending.
    // Layout-sync reconciliation must already install the route flight here.
    flushSync(() => {
      controlRef.current?.setLaneItems(afterMove)
    })

    const firstPaint = frame.current
    expect(firstPaint).not.toBeNull()
    expect(firstPaint?.flights).toHaveLength(1)
    expect(firstPaint?.flights[0]).toMatchObject({
      workItemId: "job-1",
      from: "build",
      to: "review",
      phase: "eject",
    })
    // Source keeps inert departing ticket at frozen order (index 0).
    expect(firstPaint?.build).toEqual([
      { id: "job-1", departing: true, arriving: false },
      { id: "job-2", departing: false, arriving: false },
    ])
    // Destination ticket withheld until absorb.
    expect(firstPaint?.review).toEqual([])
    // Counts still match pre-transfer presentation.
    expect(firstPaint?.displayCounts.build).toBe(2)
    expect(firstPaint?.displayCounts.review).toBe(0)

    // DOM after flush must not imply the transfer already finished.
    expect(
      container
        .querySelector("[data-flight-count]")
        ?.getAttribute("data-flight-count"),
    ).toBe("1")
    expect(
      container
        .querySelector("[data-flight-phase]")
        ?.getAttribute("data-flight-phase"),
    ).toBe("eject")
  })

  test("reduced motion snaps to destination without a route flight", async () => {
    // Re-install with reduced motion before mounting React.
    await tearDownRoot()
    installed.dispose()
    installed = installDom({ reducedMotion: true })
    container = mountRootContainer(installed.window)
    root = createRoot(container)

    const frame: FrameHolder = { current: null }
    const controlRef: {
      current: null | {
        setLaneItems: (next: Map<PipelineLaneId, readonly LaneItem[]>) => void
      }
    } = { current: null }

    const buildOnly = emptyLaneItems()
    buildOnly.set("build", [{ id: "job-1" }])

    flushSync(() => {
      root?.render(
        createElement(Harness, {
          initial: buildOnly,
          onFrame: (next) => {
            frame.current = next
          },
          controlRef,
        }),
      )
    })

    const afterMove = emptyLaneItems()
    afterMove.set("review", [{ id: "job-1" }])

    flushSync(() => {
      controlRef.current?.setLaneItems(afterMove)
    })

    const firstPaint = frame.current
    expect(firstPaint).not.toBeNull()
    expect(firstPaint?.flights).toEqual([])
    expect(firstPaint?.build).toEqual([])
    expect(firstPaint?.review).toEqual([
      { id: "job-1", departing: false, arriving: false },
    ])
    expect(firstPaint?.displayCounts.build).toBe(0)
    expect(firstPaint?.displayCounts.review).toBe(1)
  })
})
