import { ciGateRunOrderKey, compareCiGateRunOrder } from "./ci-gate-run.js"
import type { CiGateHistoryBound, CiGateObservedRun } from "./types.js"

/** One provider page of default-branch runs, pull-request executions excluded. */
export const CI_GATE_OBSERVATION_PAGE_SIZE = 100

export type CiGateCoverageState = "complete" | "gap" | "truncated"

export interface CiGateHistoricalCoverage {
  readonly state: CiGateCoverageState
  readonly branch: string | null
  /** Oldest run already accounted for, or the migrated prior cursor. */
  readonly checkpoint: CiGateHistoryBound | null
  /** Fixed top of the active gap. New runs must not move it. */
  readonly gapUpper: CiGateHistoryBound | null
  /** Oldest run this gap walk has reduced. Resume here. */
  readonly progress: CiGateHistoryBound | null
  /** Previous checkpoint or an explicitly irrelevant repair baseline. */
  readonly stop: CiGateHistoryBound | null
  /** Oldest run continuously covered downward from the latest page. */
  readonly headFloor: CiGateHistoryBound | null
  readonly pagesProcessed: number
  readonly diagnostic: string | null
  readonly pendingRuns: readonly CiGateHistoryBound[]
}

export const emptyCiGateHistoricalCoverage = (
  branch: string | null = null,
): CiGateHistoricalCoverage => ({
  state: "complete",
  branch,
  checkpoint: null,
  gapUpper: null,
  progress: null,
  stop: null,
  headFloor: null,
  pagesProcessed: 0,
  diagnostic: null,
  pendingRuns: [],
})

export const ciGateOrderKeyFromIdentity = (
  runIdentity: string,
): string | null => {
  const separator = runIdentity.indexOf(":")
  const idText =
    separator === -1 ? runIdentity : runIdentity.slice(0, separator)
  const attemptText = separator === -1 ? "1" : runIdentity.slice(separator + 1)
  const runId = Number(idText)
  const attempt = Number(attemptText)
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return null
  }
  const normalizedAttempt =
    Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1
  return ciGateRunOrderKey(runId, normalizedAttempt)
}

export const ciGateOrderKeyOf = (
  run: Pick<CiGateObservedRun, "runIdentity" | "orderKey">,
): string | null => {
  if (run.orderKey !== undefined && run.orderKey.trim() !== "") {
    return run.orderKey
  }
  return ciGateOrderKeyFromIdentity(run.runIdentity)
}

export const ciGateCoverageBound = (
  run: CiGateObservedRun,
): CiGateHistoryBound | null => {
  const orderKey = ciGateOrderKeyOf(run)
  if (orderKey === null) {
    return null
  }
  return {
    runIdentity: run.runIdentity,
    orderKey,
    createdAt: run.createdAt,
  }
}

const runIdOf = (runIdentity: string): string => {
  const separator = runIdentity.indexOf(":")
  return separator === -1 ? runIdentity : runIdentity.slice(0, separator)
}

export const sameCiGateRunId = (left: string, right: string): boolean =>
  runIdOf(left) === runIdOf(right)

const compareBounds = (
  left: CiGateHistoryBound,
  right: CiGateHistoryBound,
): number => compareCiGateRunOrder(left.orderKey, right.orderKey)

const minBound = (
  bounds: readonly CiGateHistoryBound[],
): CiGateHistoryBound | null => {
  let best: CiGateHistoryBound | null = null
  for (const bound of bounds) {
    if (best === null || compareBounds(bound, best) < 0) {
      best = bound
    }
  }
  return best
}

const reachedBound = (
  bounds: readonly CiGateHistoryBound[],
  target: CiGateHistoryBound,
): boolean =>
  bounds.some(
    (bound) =>
      sameCiGateRunId(bound.runIdentity, target.runIdentity) ||
      compareBounds(bound, target) <= 0,
  )

const passedWithoutIdentity = (
  bounds: readonly CiGateHistoryBound[],
  target: CiGateHistoryBound,
): boolean => {
  const sawIdentity = bounds.some((bound) =>
    sameCiGateRunId(bound.runIdentity, target.runIdentity),
  )
  if (sawIdentity) {
    return false
  }
  return bounds.some((bound) => compareBounds(bound, target) < 0)
}

/**
 * Existing observations become checkpoints. A missing order key is derived
 * from the run identity so live observation can resume without a history fetch.
 */
export const ciGateCoverageFromCheckpoint = (input: {
  readonly runIdentity: string | null
  readonly orderKey: string | null
  readonly createdAt: Date | null
  readonly branch: string | null
}): CiGateHistoricalCoverage => {
  const identity = input.runIdentity?.trim() ?? ""
  if (identity === "") {
    return emptyCiGateHistoricalCoverage(input.branch)
  }
  const orderKey =
    input.orderKey !== null && input.orderKey.trim() !== ""
      ? input.orderKey
      : ciGateOrderKeyFromIdentity(identity)
  if (orderKey === null || input.createdAt === null) {
    return {
      ...emptyCiGateHistoricalCoverage(input.branch),
      diagnostic:
        "Historical coverage checkpoint has no comparable run order; live observation may resume.",
    }
  }
  const bound: CiGateHistoryBound = {
    runIdentity: identity,
    orderKey,
    createdAt: input.createdAt,
  }
  return {
    state: "complete",
    branch: input.branch,
    checkpoint: bound,
    gapUpper: null,
    progress: bound,
    stop: null,
    headFloor: bound,
    pagesProcessed: 0,
    diagnostic: null,
    pendingRuns: [],
  }
}

const chooseStop = (input: {
  readonly checkpoint: CiGateHistoryBound | null
  readonly repairBaseline: CiGateHistoryBound | null
  readonly baselineIrrelevant: boolean
}): CiGateHistoryBound | null => {
  if (!input.baselineIrrelevant || input.repairBaseline === null) {
    return input.checkpoint
  }
  if (input.checkpoint === null) {
    return input.repairBaseline
  }
  return compareBounds(input.repairBaseline, input.checkpoint) > 0
    ? input.repairBaseline
    : input.checkpoint
}

const pendingFromRuns = (
  runs: readonly CiGateObservedRun[],
): readonly CiGateHistoryBound[] => {
  const pending: CiGateHistoryBound[] = []
  for (const run of runs) {
    const status = (run.rawStatus ?? "").trim().toLowerCase()
    const decisive =
      status === "completed" ||
      status === "success" ||
      status === "failed" ||
      status === "failure" ||
      run.earlyJobFailure === true
    if (decisive) {
      continue
    }
    if (
      status === "canceled" ||
      status === "cancelled" ||
      status === "skipped" ||
      status === "manual"
    ) {
      continue
    }
    const bound = ciGateCoverageBound(run)
    if (bound !== null) {
      pending.push(bound)
    }
  }
  return pending
}

const mergePending = (
  previous: readonly CiGateHistoryBound[],
  incoming: readonly CiGateHistoryBound[],
  seen: readonly CiGateHistoryBound[],
): readonly CiGateHistoryBound[] => {
  // A rerun is a new attempt of the same run id. Seeing that id, even as a
  // decisive attempt, must drop the old pending identity so dedup cannot hide
  // the status change.
  const seenRunIds = new Set(seen.map((bound) => runIdOf(bound.runIdentity)))
  const next = new Map<string, CiGateHistoryBound>()
  for (const bound of previous) {
    if (!seenRunIds.has(runIdOf(bound.runIdentity))) {
      next.set(runIdOf(bound.runIdentity), bound)
    }
  }
  for (const bound of incoming) {
    next.set(runIdOf(bound.runIdentity), bound)
  }
  return [...next.values()]
}

const boundsOf = (
  runs: readonly CiGateObservedRun[],
): readonly CiGateHistoryBound[] => {
  const bounds: CiGateHistoryBound[] = []
  for (const run of runs) {
    const bound = ciGateCoverageBound(run)
    if (bound !== null) {
      bounds.push(bound)
    }
  }
  return bounds
}

const truncated = (
  previous: CiGateHistoricalCoverage,
  branch: string | null,
  diagnostic: string,
  pagesProcessed: number,
): CiGateHistoricalCoverage => ({
  ...previous,
  state: "truncated",
  branch,
  gapUpper: null,
  progress: null,
  diagnostic,
  pagesProcessed,
})

/**
 * Apply one newest page. A full page that does not reach the checkpoint opens
 * a gap whose upper boundary stays fixed. A short page that misses the
 * checkpoint is truncated history, not an endless scan.
 */
export const applyLatestHistoricalCoverage = (input: {
  readonly previous: CiGateHistoricalCoverage
  readonly branch: string
  readonly runs: readonly CiGateObservedRun[]
  readonly historyExhausted: boolean
  readonly repairBaseline: CiGateHistoryBound | null
  readonly baselineIrrelevant: boolean
}): CiGateHistoricalCoverage => {
  if (
    input.previous.branch !== null &&
    input.previous.branch !== input.branch
  ) {
    return applyLatestHistoricalCoverage({
      ...input,
      previous: emptyCiGateHistoricalCoverage(null),
    })
  }
  const bounds = boundsOf(input.runs)
  const oldest = minBound(bounds)
  const pending = pendingFromRuns(input.runs)
  const branch = input.branch

  if (oldest === null) {
    if (
      input.historyExhausted &&
      input.previous.checkpoint !== null &&
      input.runs.length === 0
    ) {
      return truncated(
        input.previous,
        branch,
        "Historical coverage incomplete: available history is empty and the coverage checkpoint was not found.",
        input.previous.pagesProcessed,
      )
    }
    return {
      ...input.previous,
      branch,
      pendingRuns: mergePending(input.previous.pendingRuns, pending, bounds),
    }
  }

  const checkpoint = input.previous.checkpoint
  const sawCheckpoint =
    checkpoint !== null &&
    bounds.some((bound) =>
      sameCiGateRunId(bound.runIdentity, checkpoint.runIdentity),
    )
  // An older remaining run is not the checkpoint. If we passed its order
  // without seeing that identity, history deleted it.
  if (checkpoint !== null && passedWithoutIdentity(bounds, checkpoint)) {
    return truncated(
      {
        ...input.previous,
        headFloor: oldest,
        pendingRuns: mergePending(input.previous.pendingRuns, pending, bounds),
      },
      branch,
      "Historical coverage incomplete: the coverage checkpoint was not found in available history.",
      input.previous.pagesProcessed,
    )
  }
  const connectedToHead =
    input.previous.headFloor === null ||
    reachedBound(bounds, input.previous.headFloor)

  if (input.previous.state === "gap" && input.previous.gapUpper !== null) {
    return {
      ...input.previous,
      branch,
      headFloor: connectedToHead ? input.previous.headFloor : oldest,
      pendingRuns: mergePending(input.previous.pendingRuns, pending, bounds),
    }
  }

  if (checkpoint !== null && !sawCheckpoint && !input.historyExhausted) {
    return {
      state: "gap",
      branch,
      checkpoint,
      gapUpper: oldest,
      progress: oldest,
      stop: chooseStop({
        checkpoint,
        repairBaseline: input.repairBaseline,
        baselineIrrelevant: input.baselineIrrelevant,
      }),
      headFloor: oldest,
      pagesProcessed: input.previous.pagesProcessed,
      diagnostic: null,
      pendingRuns: pending,
    }
  }

  if (checkpoint !== null && !sawCheckpoint && input.historyExhausted) {
    return truncated(
      {
        ...input.previous,
        headFloor: oldest,
        pendingRuns: mergePending(input.previous.pendingRuns, pending, bounds),
      },
      branch,
      "Historical coverage incomplete: available history ended before the coverage checkpoint.",
      input.previous.pagesProcessed,
    )
  }

  if (checkpoint === null && !input.historyExhausted) {
    return {
      state: "gap",
      branch,
      checkpoint: null,
      gapUpper: oldest,
      progress: oldest,
      stop: chooseStop({
        checkpoint: null,
        repairBaseline: input.repairBaseline,
        baselineIrrelevant: input.baselineIrrelevant,
      }),
      headFloor: oldest,
      pagesProcessed: 0,
      diagnostic: null,
      pendingRuns: pending,
    }
  }

  return {
    state: "complete",
    branch,
    checkpoint: oldest,
    gapUpper: null,
    progress: oldest,
    stop: null,
    headFloor: oldest,
    pagesProcessed: input.previous.pagesProcessed,
    diagnostic: null,
    pendingRuns: mergePending([], pending, bounds),
  }
}

/**
 * Upper bound for the next catch-up page. A hole between the newest page and
 * the fixed gap upper is filled first; the active gap is not restarted.
 */
export const nextCiGateCatchUpBound = (
  coverage: CiGateHistoricalCoverage,
): CiGateHistoryBound | null => {
  if (coverage.state !== "gap") {
    return null
  }
  const gapUpper = coverage.gapUpper
  const headFloor = coverage.headFloor
  if (
    gapUpper !== null &&
    headFloor !== null &&
    compareBounds(headFloor, gapUpper) > 0
  ) {
    return headFloor
  }
  // A pending run above the frontier is refreshed by a single-run revisit.
  // It must not rewind this history-page bound.
  return coverage.progress ?? gapUpper
}

/**
 * Newest pending run strictly above the catch-up page bound. Null when the
 * frontier page already covers every pending attempt.
 */
export const pendingRunAboveFrontier = (
  coverage: CiGateHistoricalCoverage,
  frontier: CiGateHistoryBound,
): CiGateHistoryBound | null => {
  let newest: CiGateHistoryBound | null = null
  for (const pending of coverage.pendingRuns) {
    if (compareBounds(pending, frontier) <= 0) {
      continue
    }
    if (newest === null || compareBounds(pending, newest) > 0) {
      newest = pending
    }
  }
  return newest
}

const windowRuns = (
  runs: readonly CiGateObservedRun[],
  notNewerThan: CiGateHistoryBound,
): readonly CiGateObservedRun[] =>
  runs.filter((run) => {
    const orderKey = ciGateOrderKeyOf(run)
    if (orderKey === null) {
      return false
    }
    return compareCiGateRunOrder(orderKey, notNewerThan.orderKey) <= 0
  })

/**
 * Reduce one catch-up page and advance the durable frontier. Repeating the
 * same bound does not rescan as a new gap; a missing checkpoint terminates.
 */
export const applyCatchUpHistoricalCoverage = (input: {
  readonly previous: CiGateHistoricalCoverage
  readonly runs: readonly CiGateObservedRun[]
  readonly historyExhausted: boolean
}): CiGateHistoricalCoverage => {
  if (input.previous.state !== "gap") {
    return input.previous
  }
  const requested = nextCiGateCatchUpBound(input.previous)
  if (requested === null) {
    return input.previous
  }
  const inWindow = windowRuns(input.runs, requested)
  const bounds = boundsOf(inWindow)
  const oldest = minBound(bounds)
  const stop = input.previous.stop ?? input.previous.checkpoint
  const pagesProcessed = input.previous.pagesProcessed + 1
  // A single-run revisit is newer than the history page. Record its status so
  // a decisive attempt leaves the pending set, without moving the frontier.
  const revisited = input.runs.filter((run) => {
    const orderKey = ciGateOrderKeyOf(run)
    if (orderKey === null) {
      return false
    }
    return compareCiGateRunOrder(orderKey, requested.orderKey) > 0
  })
  const pending = mergePending(
    input.previous.pendingRuns,
    pendingFromRuns([...inWindow, ...revisited]),
    [...bounds, ...boundsOf(revisited)],
  )
  const sawStop = stop !== null && reachedBound(bounds, stop)
  const missedStop = stop !== null && passedWithoutIdentity(bounds, stop)

  if (missedStop || (input.historyExhausted && stop !== null && !sawStop)) {
    return truncated(
      { ...input.previous, pendingRuns: pending },
      input.previous.branch,
      "Historical coverage incomplete: the coverage checkpoint is not in available history.",
      pagesProcessed,
    )
  }

  if (sawStop || (input.historyExhausted && stop === null)) {
    return {
      ...input.previous,
      state: "complete",
      checkpoint: oldest ?? input.previous.checkpoint,
      gapUpper: null,
      progress: oldest ?? input.previous.progress,
      stop: null,
      headFloor: input.previous.gapUpper ?? input.previous.headFloor,
      pagesProcessed,
      diagnostic: null,
      pendingRuns: pending,
    }
  }

  if (oldest === null) {
    return {
      ...input.previous,
      pagesProcessed,
      pendingRuns: pending,
      diagnostic:
        "Historical catch-up returned no runs inside the coverage window.",
      state: input.historyExhausted ? "truncated" : "gap",
    }
  }

  const gapUpper = input.previous.gapUpper
  const fillingHole =
    gapUpper !== null &&
    input.previous.headFloor !== null &&
    compareBounds(input.previous.headFloor, gapUpper) > 0 &&
    compareBounds(requested, gapUpper) > 0

  if (fillingHole && compareBounds(oldest, gapUpper) > 0) {
    return {
      ...input.previous,
      headFloor: oldest,
      pagesProcessed,
      pendingRuns: pending,
      diagnostic: null,
    }
  }

  const advanced =
    input.previous.progress === null ||
    compareBounds(oldest, input.previous.progress) < 0
  return {
    ...input.previous,
    progress: advanced ? oldest : input.previous.progress,
    headFloor: gapUpper ?? input.previous.headFloor,
    pagesProcessed,
    pendingRuns: pending,
    diagnostic: advanced
      ? null
      : "Historical catch-up overlapped an already committed page.",
  }
}

export const catchUpNotNewerThan = (
  coverage: CiGateHistoricalCoverage,
): CiGateHistoryBound | null => nextCiGateCatchUpBound(coverage)

export const sortCiGateRunsNewestFirst = (
  runs: readonly CiGateObservedRun[],
): readonly CiGateObservedRun[] =>
  [...runs].sort((left, right) => {
    const leftKey = ciGateOrderKeyOf(left)
    const rightKey = ciGateOrderKeyOf(right)
    if (leftKey === null || rightKey === null) {
      return 0
    }
    return compareCiGateRunOrder(rightKey, leftKey)
  })
