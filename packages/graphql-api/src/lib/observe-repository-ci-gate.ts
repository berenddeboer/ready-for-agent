import { Clock, Effect, Result } from "effect"
import { ulid } from "ulidx"
import {
  type CiFailureIncidentRecord,
  type CiGateDefinitionObservationRecord,
  type CiGateDefinitionRecord,
  type CiGateRecoveryReason,
  type CiGateSnapshotRecord,
  DbService,
  type RepositoryRecord,
} from "@ready-for-agent/db-service"
import {
  CI_GATE_OBSERVATION_PAGE_SIZE,
  type CiGateDefinitionObservation,
  type CiGateHistoryBound,
  type CiGateObservation,
  type CiGateObservedRun,
  type ForgeOperationOrigin,
  applyCatchUpHistoricalCoverage,
  applyLatestHistoricalCoverage,
  ciGateOrderKeyOf,
  classifyCiGateObservedRun,
  compareCiGateRunOrder,
  formatUserFacingError,
  nextCiGateCatchUpBound,
  pendingRunAboveFrontier,
  sortCiGateRunsNewestFirst,
} from "@ready-for-agent/forge-contract"
import {
  WorkItemLifecycle,
  forgeObservation,
} from "@ready-for-agent/work-item-lifecycle"
import {
  historicalCoverageFromRecord,
  withHistoricalCoverage,
} from "./ci-gate-coverage-record.js"

export type RepositoryCiGateStatus = "disabled" | "open" | "closed" | "degraded"

export const ciGateObservationErrorMessage = (error: unknown): string => {
  const formatted = formatUserFacingError(error, "CI Gate observation failed")
  return formatted.trim() === "" ? "CI Gate observation failed" : formatted
}

const isPermissionError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false
  }
  const record = error as {
    readonly statusCode?: unknown
    readonly message?: unknown
  }
  if (record.statusCode === 403) {
    return true
  }
  return (
    typeof record.message === "string" &&
    (record.message.includes("Actions read required") ||
      record.message.includes("API/pipeline read required") ||
      record.message.includes("Build read required"))
  )
}

const runIdFromIdentity = (runIdentity: string): string => {
  const separator = runIdentity.indexOf(":")
  return separator === -1 ? runIdentity : runIdentity.slice(0, separator)
}

const isSameObservedRun = (
  runIdentity: string,
  lastRunIdentity: string,
): boolean =>
  runIdentity === lastRunIdentity ||
  runIdFromIdentity(runIdentity) === runIdFromIdentity(lastRunIdentity)

const newlyObservedRuns = (
  runs: readonly CiGateObservedRun[],
  lastRunIdentity: string | null,
  lastOrderKey: string | null,
): readonly CiGateObservedRun[] => {
  if (lastRunIdentity === null) {
    return runs
  }
  if (lastOrderKey !== null && lastOrderKey !== "") {
    return runs.filter((run) => {
      const orderKey = ciGateOrderKeyOf(run)
      if (orderKey === null) {
        return !isSameObservedRun(run.runIdentity, lastRunIdentity)
      }
      return compareCiGateRunOrder(orderKey, lastOrderKey) > 0
    })
  }
  const next: CiGateObservedRun[] = []
  for (const run of runs) {
    next.push(run)
    if (isSameObservedRun(run.runIdentity, lastRunIdentity)) {
      break
    }
  }
  return next
}

const retainedLatestRun = (
  previous: CiGateDefinitionObservationRecord | undefined,
): CiGateObservedRun | null => {
  if (
    previous === undefined ||
    previous.lastRunIdentity === null ||
    previous.lastRunIdentity === ""
  ) {
    return null
  }
  return {
    runIdentity: previous.lastRunIdentity,
    htmlUrl: previous.lastRunHtmlUrl,
    headSha: previous.lastHeadSha,
    headRef: previous.lastHeadRef,
    event: previous.lastEvent ?? "",
    createdAt: previous.lastRunCreatedAt ?? new Date(0),
    updatedAt: previous.lastRunUpdatedAt,
    startedAt: null,
    rawStatus: previous.lastRawStatus,
    rawConclusion: previous.lastRawConclusion,
    ...(previous.lastRunOrderKey === null ||
    previous.lastRunOrderKey === undefined
      ? {}
      : { orderKey: previous.lastRunOrderKey }),
    earlyJobFailure: previous.lastEarlyJobFailure === true,
  }
}

type CiGateDecisiveObservation = {
  readonly kind: "failure" | "success"
  readonly run: CiGateObservedRun
}

/**
 * Decisive result from this turn's newest page. Catch-up runs are older than
 * that page's frontier, so they must be compared against this result. Without
 * it, an older failure can close the gate after a newer success, or an older
 * success can clear a newer failure.
 */
type NewestPageLatchContext =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "observed"
      readonly latestDecisive: CiGateDecisiveObservation | null
    }

const comparableRun = (run: CiGateObservedRun): CiGateObservedRun => {
  const orderKey = ciGateOrderKeyOf(run)
  if (orderKey === null || run.orderKey === orderKey) {
    return run
  }
  return { ...run, orderKey }
}

/**
 * Stored failure, placed by order key so an older catch-up run cannot clear
 * or replace it. A newer decisive success still sorts ahead and clears it.
 */
const storedLatchedFailure = (
  record: CiGateDefinitionObservationRecord | undefined,
): CiGateObservedRun | null => {
  if (
    record === undefined ||
    record.failureLatched !== true ||
    record.latchedRunIdentity === null ||
    record.latchedRunIdentity === ""
  ) {
    return null
  }
  const storedKey = record.latchedRunOrderKey?.trim() ?? ""
  const orderKey =
    storedKey !== ""
      ? storedKey
      : ciGateOrderKeyOf({ runIdentity: record.latchedRunIdentity })
  if (orderKey === null) {
    return null
  }
  return {
    runIdentity: record.latchedRunIdentity,
    htmlUrl: record.latchedRunHtmlUrl,
    headSha: null,
    headRef: null,
    event: "",
    createdAt: new Date(0),
    updatedAt: null,
    startedAt: null,
    rawStatus: "completed",
    rawConclusion: "failure",
    orderKey,
  }
}

const isThrottle = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { readonly _tag?: unknown })._tag === "GitHubThrottledError"

const reduceObservedRuns = (
  runs: readonly CiGateObservedRun[],
  previousLatchIdentity: string | null,
) => {
  let latestDecisive: {
    readonly kind: "failure" | "success"
    readonly run: CiGateObservedRun
  } | null = null
  let olderFailure: CiGateObservedRun | null = null
  let latchedRunStillNewerThanSuccess = false
  for (const run of runs) {
    const kind = classifyCiGateObservedRun(run)
    const isPreviousLatch =
      previousLatchIdentity !== null &&
      isSameObservedRun(run.runIdentity, previousLatchIdentity)
    if (latestDecisive === null) {
      if (isPreviousLatch && kind !== "success") {
        latchedRunStillNewerThanSuccess = true
      }
      if (kind === "failure" || kind === "success") {
        latestDecisive = { kind, run }
      }
      continue
    }
    if (
      latestDecisive.kind === "success" &&
      kind === "failure" &&
      olderFailure === null
    ) {
      olderFailure = run
    }
  }
  return { latestDecisive, olderFailure, latchedRunStillNewerThanSuccess }
}

const labelsFor = (
  identities: readonly string[],
  definitions: readonly CiGateDefinitionRecord[],
): string =>
  identities
    .map(
      (identity) =>
        definitions.find((definition) => definition.identity === identity)
          ?.displayLabel ?? identity,
    )
    .join(", ")

const incidentId = (): string => `cfi-${ulid()}`

const copyIncident = (
  incident: CiFailureIncidentRecord,
  patch: Partial<CiFailureIncidentRecord>,
): CiFailureIncidentRecord => ({
  ...incident,
  ...patch,
  definitions: patch.definitions ?? incident.definitions,
})

const wakeMergeHoldsIfGateNotClosed = (
  repositoryId: string,
  status: RepositoryCiGateStatus,
) =>
  status === "closed"
    ? Effect.void
    : Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* lifecycle
          .releaseWaitingForCiRepair(repositoryId)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "Failed releasing Waiting for CI Repair Work Items",
                { repositoryId, error: String(error) },
              ),
            ),
          )
      })

export const deriveRepositoryCiGateStatus = (input: {
  readonly selectedCount: number
  readonly observations: readonly CiGateDefinitionObservationRecord[]
}): RepositoryCiGateStatus => {
  if (input.selectedCount === 0) {
    return "disabled"
  }
  if (input.observations.some((observation) => observation.failureLatched)) {
    return "closed"
  }
  if (
    input.observations.some(
      (observation) => observation.observationError !== null,
    )
  ) {
    return "degraded"
  }
  return "open"
}

const unavailableObservation = (input: {
  readonly previous: CiGateDefinitionObservationRecord | undefined
  readonly identity: string
  readonly observedAt: Date
  readonly reason: "permission" | "not_found" | "error"
  readonly message: string
}): CiGateDefinitionObservationRecord => ({
  identity: input.identity,
  lastObservedAt: input.observedAt,
  lastRunIdentity: input.previous?.lastRunIdentity ?? null,
  lastRunHtmlUrl: input.previous?.lastRunHtmlUrl ?? null,
  lastHeadSha: input.previous?.lastHeadSha ?? null,
  lastHeadRef: input.previous?.lastHeadRef ?? null,
  lastEvent: input.previous?.lastEvent ?? null,
  lastRawStatus: input.previous?.lastRawStatus ?? null,
  lastRawConclusion: input.previous?.lastRawConclusion ?? null,
  lastRunCreatedAt: input.previous?.lastRunCreatedAt ?? null,
  lastRunUpdatedAt: input.previous?.lastRunUpdatedAt ?? null,
  failureLatched: input.previous?.failureLatched ?? false,
  latchedRunIdentity: input.previous?.latchedRunIdentity ?? null,
  latchedRunHtmlUrl: input.previous?.latchedRunHtmlUrl ?? null,
  lastRunOrderKey: input.previous?.lastRunOrderKey ?? null,
  latchedRunOrderKey: input.previous?.latchedRunOrderKey ?? null,
  lastEarlyJobFailure: input.previous?.lastEarlyJobFailure === true,
  observationError: input.message,
  observationErrorKind: input.reason,
})

const applyObservedRuns = (input: {
  readonly previous: CiGateDefinitionObservationRecord | undefined
  readonly identity: string
  readonly observedAt: Date
  readonly runs: readonly CiGateObservedRun[]
  readonly ignorePreviousLatch: boolean
  readonly retainNewerLatest: boolean
  /** Decisive runs already known to be newer than this page. Not stored as latest. */
  readonly decisiveContext?: readonly CiGateObservedRun[]
}): {
  readonly observation: CiGateDefinitionObservationRecord
  readonly sameObservationResolvedFailure: CiGateObservedRun | null
  readonly latestDecisive: CiGateDecisiveObservation | null
} => {
  const lastSeen = input.ignorePreviousLatch
    ? null
    : (input.previous?.lastRunIdentity ?? null)
  const lastOrderKey = input.ignorePreviousLatch
    ? null
    : (input.previous?.lastRunOrderKey ?? null)
  const previousLatchIdentity = input.ignorePreviousLatch
    ? null
    : input.previous?.failureLatched === true
      ? input.previous.latchedRunIdentity
      : null
  const sorted = sortCiGateRunsNewestFirst(input.runs)
  const retained = input.retainNewerLatest
    ? retainedLatestRun(input.ignorePreviousLatch ? undefined : input.previous)
    : null
  const newestKey = sorted[0] === undefined ? null : ciGateOrderKeyOf(sorted[0])
  const keepPreviousLatest =
    retained !== null &&
    lastOrderKey !== null &&
    lastOrderKey !== "" &&
    newestKey !== null &&
    compareCiGateRunOrder(newestKey, lastOrderKey) < 0
  const contextRuns = (input.decisiveContext ?? []).map(comparableRun)
  const compared = sortCiGateRunsNewestFirst([
    ...(keepPreviousLatest && retained !== null ? [retained] : []),
    ...sorted,
    ...contextRuns,
  ])
  const fresh = newlyObservedRuns(sorted, lastSeen, lastOrderKey)
  const reducedFresh = reduceObservedRuns(fresh, previousLatchIdentity)
  const reduced = reduceObservedRuns(compared, previousLatchIdentity)
  const latest = keepPreviousLatest ? retained : sorted[0]
  let failureLatched = input.ignorePreviousLatch
    ? false
    : (input.previous?.failureLatched ?? false)
  let latchedRunIdentity = input.ignorePreviousLatch
    ? null
    : (input.previous?.latchedRunIdentity ?? null)
  let latchedRunHtmlUrl = input.ignorePreviousLatch
    ? null
    : (input.previous?.latchedRunHtmlUrl ?? null)
  let latchedRunOrderKey = input.ignorePreviousLatch
    ? null
    : (input.previous?.latchedRunOrderKey ?? null)
  if (reduced.latestDecisive?.kind === "failure") {
    failureLatched = true
    latchedRunIdentity = reduced.latestDecisive.run.runIdentity
    latchedRunHtmlUrl = reduced.latestDecisive.run.htmlUrl
    latchedRunOrderKey = reduced.latestDecisive.run.orderKey ?? null
  } else if (reduced.latestDecisive?.kind === "success") {
    const successClearsLatch =
      previousLatchIdentity === null ||
      isSameObservedRun(
        reduced.latestDecisive.run.runIdentity,
        previousLatchIdentity,
      ) ||
      !reduced.latchedRunStillNewerThanSuccess
    if (successClearsLatch) {
      failureLatched = false
      latchedRunIdentity = null
      latchedRunHtmlUrl = null
      latchedRunOrderKey = null
    }
  }
  const sameObservationResolvedFailure =
    !input.ignorePreviousLatch &&
    !(input.previous?.failureLatched ?? false) &&
    reducedFresh.latestDecisive?.kind === "success"
      ? reducedFresh.olderFailure
      : null
  const previousRun = input.ignorePreviousLatch ? undefined : input.previous
  return {
    observation: {
      identity: input.identity,
      lastObservedAt: input.observedAt,
      lastRunIdentity: latest?.runIdentity ?? lastSeen,
      lastRunHtmlUrl: latest?.htmlUrl ?? previousRun?.lastRunHtmlUrl ?? null,
      lastHeadSha: latest?.headSha ?? previousRun?.lastHeadSha ?? null,
      lastHeadRef: latest?.headRef ?? previousRun?.lastHeadRef ?? null,
      lastEvent: latest?.event ?? previousRun?.lastEvent ?? null,
      lastRawStatus: latest?.rawStatus ?? previousRun?.lastRawStatus ?? null,
      // A new run with no conclusion must not keep the previous run's conclusion.
      // Otherwise a still-pending newest run is later read as a success.
      lastRawConclusion:
        latest === undefined
          ? (previousRun?.lastRawConclusion ?? null)
          : (latest.rawConclusion ?? null),
      lastRunCreatedAt:
        latest?.createdAt ?? previousRun?.lastRunCreatedAt ?? null,
      lastRunUpdatedAt:
        latest?.updatedAt ?? previousRun?.lastRunUpdatedAt ?? null,
      failureLatched,
      latchedRunIdentity,
      latchedRunHtmlUrl,
      // A new run with no order key must not keep the previous run's key.
      // An empty poll keeps the previous run, including its key and flag.
      lastRunOrderKey:
        latest === undefined
          ? (previousRun?.lastRunOrderKey ?? null)
          : (latest.orderKey ?? null),
      latchedRunOrderKey,
      lastEarlyJobFailure:
        latest === undefined
          ? previousRun?.lastEarlyJobFailure === true
          : latest.earlyJobFailure === true,
      observationError: null,
      observationErrorKind: null,
    },
    sameObservationResolvedFailure,
    latestDecisive: reduced.latestDecisive,
  }
}

const observationFromAdapter = (input: {
  readonly previous: CiGateDefinitionObservationRecord | undefined
  readonly observedAt: Date
  readonly result: CiGateDefinitionObservation
  readonly ignorePreviousLatch: boolean
  readonly retainNewerLatest: boolean
  readonly decisiveContext?: readonly CiGateObservedRun[]
}): {
  readonly observation: CiGateDefinitionObservationRecord
  readonly sameObservationResolvedFailure: CiGateObservedRun | null
  readonly latestDecisive: CiGateDecisiveObservation | null
} => {
  if (input.result.kind === "unavailable") {
    return {
      observation: unavailableObservation({
        previous: input.ignorePreviousLatch ? undefined : input.previous,
        identity: input.result.identity,
        observedAt: input.observedAt,
        reason: input.result.reason,
        message: input.result.message,
      }),
      sameObservationResolvedFailure: null,
      latestDecisive: null,
    }
  }
  return applyObservedRuns({
    previous: input.previous,
    identity: input.result.identity,
    observedAt: input.observedAt,
    runs: input.result.runs,
    ignorePreviousLatch: input.ignorePreviousLatch,
    retainNewerLatest: input.retainNewerLatest,
    ...(input.decisiveContext === undefined
      ? {}
      : { decisiveContext: input.decisiveContext }),
  })
}

const observeRepositoryCiGateBody = Effect.fn("observeRepositoryCiGate.body")(
  function* (input: {
    readonly repository: RepositoryRecord
    readonly origin: ForgeOperationOrigin
  }) {
    const db = yield* DbService
    const definitions = yield* db.listCiGateDefinitions(input.repository.id)
    const previous = yield* db.loadCiGateSnapshot(input.repository.id)
    const nowMs = yield* Clock.currentTimeMillis
    const observedAt = new Date(nowMs)
    const previousStatus = deriveRepositoryCiGateStatus({
      selectedCount: previous.observations.length,
      observations: previous.observations,
    })

    if (definitions.length === 0) {
      const incidentsToUpsert: CiFailureIncidentRecord[] = []
      if (previous.activeIncident !== null) {
        incidentsToUpsert.push(
          copyIncident(previous.activeIncident, {
            status: "resolved",
            resolvedAt: observedAt,
            recoveryReason: "empty_selection",
            summary: "CI Gate recovered: CI Gate selection cleared.",
          }),
        )
      }
      yield* db.commitCiGateSnapshot({
        repositoryId: input.repository.id,
        defaultBranch: previous.state?.defaultBranch ?? null,
        lastObservedAt: observedAt,
        observations: [],
        incidentsToUpsert,
      })
      if (previousStatus !== "disabled") {
        yield* Effect.logInfo("Repository CI Gate disabled", {
          repositoryId: input.repository.id,
          status: "disabled",
          recoveryReason: "empty_selection",
        })
      }
      yield* wakeMergeHoldsIfGateNotClosed(input.repository.id, "disabled")
      return
    }

    const previousByIdentity = new Map(
      previous.observations.map((observation) => [
        observation.identity,
        observation,
      ]),
    )
    const removedIdentities = previous.observations
      .map((observation) => observation.identity)
      .filter(
        (identity) =>
          !definitions.some((definition) => definition.identity === identity),
      )

    const baselines = yield* db.listCiRepairBaselineBounds(input.repository.id)
    const baselineBoundFor = (identity: string): CiGateHistoryBound | null => {
      const row = baselines.find(
        (baseline) => baseline.definitionIdentity === identity,
      )
      const orderKey = row?.orderKey ?? row?.floorOrderKey ?? null
      const runIdentity = row?.runIdentity ?? null
      if (
        orderKey === null ||
        orderKey === "" ||
        runIdentity === null ||
        runIdentity === ""
      ) {
        return null
      }
      return { runIdentity, orderKey, createdAt: new Date(0) }
    }

    const forgeRepository = {
      forge: input.repository.forge,
      forgeHost: input.repository.forgeHost,
      projectPath: input.repository.projectPath,
    }
    const observationsAdapter = yield* forgeObservation(input.repository)
    let snapshot = previous
    let defaultBranch = previous.state?.defaultBranch ?? null
    let branchChanged = false
    let stopForThrottle = false
    const newestPageLatch = new Map<string, NewestPageLatchContext>()

    const selectedObservations = () =>
      snapshot.observations.filter((observation) =>
        definitions.some(
          (definition) => definition.identity === observation.identity,
        ),
      )

    const commitProgress = Effect.fn("commitCiGateDefinitionProgress")(
      function* (progress: {
        readonly observations: readonly CiGateDefinitionObservationRecord[]
        readonly sameObservationFailures: readonly {
          readonly identity: string
          readonly run: CiGateObservedRun
        }[]
        readonly phase: "latest" | "catch_up"
      }) {
        let recoveryIfCleared: CiGateRecoveryReason = "newer_success"
        if (branchChanged) {
          recoveryIfCleared = "default_branch_changed"
        } else if (removedIdentities.length > 0) {
          const successClearedLatch = progress.observations.some((current) => {
            const prior = previousByIdentity.get(current.identity)
            return (
              prior?.failureLatched === true &&
              current.failureLatched === false &&
              current.observationError === null
            )
          })
          recoveryIfCleared = successClearedLatch
            ? "newer_success"
            : "definition_removed"
        }
        yield* commitWithIncidents({
          repository: input.repository,
          defaultBranch,
          observedAt,
          definitions,
          previous: snapshot,
          observations: progress.observations,
          removedIdentities,
          sameObservationFailures: progress.sameObservationFailures,
          recoveryIfCleared,
          previousStatus,
        })
        snapshot = yield* db.loadCiGateSnapshot(input.repository.id)
        for (const observation of progress.observations) {
          yield* Effect.logInfo("CI Gate observation committed", {
            repositoryId: input.repository.id,
            definitionIdentity: observation.identity,
            phase: progress.phase,
            latestRunIdentity: observation.lastRunIdentity,
            coverageState: observation.coverageState ?? "complete",
            checkpointRunIdentity:
              observation.coverageCheckpointRunIdentity ?? null,
            gapUpperRunIdentity:
              observation.coverageGapUpperRunIdentity ?? null,
            progressRunIdentity:
              observation.coverageProgressRunIdentity ?? null,
            pagesProcessed: observation.coveragePagesProcessed ?? 0,
            coverageDiagnostic: observation.coverageDiagnostic,
            liveObservationFailed: observation.observationError !== null,
            historicalCoverageIncomplete:
              observation.coverageState === "gap" ||
              observation.coverageState === "truncated",
          })
        }
      },
    )

    const replaceObservation = (
      updated: CiGateDefinitionObservationRecord,
    ): CiGateDefinitionObservationRecord[] => {
      const current = selectedObservations()
      const without = current.filter(
        (observation) => observation.identity !== updated.identity,
      )
      return [...without, updated]
    }

    for (const definition of definitions) {
      if (stopForThrottle) {
        break
      }
      const prior = snapshot.observations.find(
        (observation) => observation.identity === definition.identity,
      )
      const lastRunIdentities: { [definitionIdentity: string]: string } = {}
      if (
        prior?.lastRunIdentity !== null &&
        prior?.lastRunIdentity !== undefined &&
        prior.lastRunIdentity !== ""
      ) {
        lastRunIdentities[definition.identity] = prior.lastRunIdentity
      }
      const adapterResult: Result.Result<CiGateObservation, unknown> =
        yield* observationsAdapter
          .observeCiGate(
            forgeRepository,
            {
              definitionIdentities: [definition.identity],
              lastRunIdentities,
              scope: { kind: "latest" },
            },
            { origin: input.origin },
          )
          .pipe(Effect.result)
      if (Result.isFailure(adapterResult)) {
        const message = ciGateObservationErrorMessage(adapterResult.failure)
        const reason = isPermissionError(adapterResult.failure)
          ? ("permission" as const)
          : ("error" as const)
        yield* Effect.logWarning("CI Gate live observation failed", {
          repositoryId: input.repository.id,
          definitionIdentity: definition.identity,
          error: message,
          historicalCoverageIncomplete: false,
        })
        newestPageLatch.set(definition.identity, { kind: "unavailable" })
        const failed = withHistoricalCoverage(
          unavailableObservation({
            previous: branchChanged ? undefined : prior,
            identity: definition.identity,
            observedAt,
            reason,
            message,
          }),
          historicalCoverageFromRecord(
            branchChanged ? undefined : prior,
            defaultBranch,
          ),
        )
        yield* commitProgress({
          observations: replaceObservation(failed),
          sameObservationFailures: [],
          phase: "latest",
        })
        if (isThrottle(adapterResult.failure)) {
          stopForThrottle = true
        }
        continue
      }
      const observation = adapterResult.success
      if (
        defaultBranch !== null &&
        defaultBranch !== observation.defaultBranch
      ) {
        branchChanged = true
      }
      defaultBranch = observation.defaultBranch
      const result =
        observation.observations.find(
          (entry) => entry.identity === definition.identity,
        ) ??
        ({
          identity: definition.identity,
          kind: "unavailable",
          reason: "error",
          message: `CI Gate Definition ${definition.identity} could not be observed`,
        } satisfies CiGateDefinitionObservation)
      const applied = observationFromAdapter({
        previous: prior,
        observedAt,
        result,
        ignorePreviousLatch: branchChanged,
        retainNewerLatest: false,
      })
      newestPageLatch.set(
        definition.identity,
        result.kind === "observed"
          ? { kind: "observed", latestDecisive: applied.latestDecisive }
          : { kind: "unavailable" },
      )
      const previousCoverage = historicalCoverageFromRecord(
        branchChanged ? undefined : prior,
        defaultBranch,
      )
      const runs = result.kind === "observed" ? result.runs : []
      const exhausted =
        result.kind === "observed"
          ? (result.historyExhausted ??
            runs.length < CI_GATE_OBSERVATION_PAGE_SIZE)
          : false
      const coverage =
        result.kind === "unavailable"
          ? previousCoverage
          : applyLatestHistoricalCoverage({
              previous: previousCoverage,
              branch: observation.defaultBranch,
              runs,
              historyExhausted: exhausted,
              repairBaseline: baselineBoundFor(definition.identity),
              baselineIrrelevant:
                applied.observation.failureLatched ||
                applied.observation.lastRawConclusion === "success" ||
                applied.observation.lastRawConclusion === "succeeded" ||
                applied.observation.lastRawConclusion === "failure" ||
                applied.observation.lastRawConclusion === "failed" ||
                applied.observation.lastEarlyJobFailure === true,
            })
      const stored = withHistoricalCoverage(applied.observation, coverage)
      yield* commitProgress({
        observations: replaceObservation(stored),
        sameObservationFailures:
          applied.sameObservationResolvedFailure === null
            ? []
            : [
                {
                  identity: definition.identity,
                  run: applied.sameObservationResolvedFailure,
                },
              ],
        phase: "latest",
      })
    }

    const lifecycle = yield* WorkItemLifecycle
    yield* lifecycle.considerAutomaticCiRepair(input.repository.id)

    if (!stopForThrottle) {
      for (const definition of definitions) {
        if (stopForThrottle) {
          break
        }
        const prior = snapshot.observations.find(
          (observation) => observation.identity === definition.identity,
        )
        const coverage = historicalCoverageFromRecord(prior, defaultBranch)
        const bound = nextCiGateCatchUpBound(coverage)
        if (coverage.state !== "gap" || bound === null) {
          continue
        }
        const adapterResult: Result.Result<CiGateObservation, unknown> =
          yield* observationsAdapter
            .observeCiGate(
              forgeRepository,
              {
                definitionIdentities: [definition.identity],
                lastRunIdentities: {},
                scope: {
                  kind: "catch_up",
                  definitionIdentity: definition.identity,
                  notNewerThan: bound,
                  stopAt: coverage.stop,
                  revisit: pendingRunAboveFrontier(coverage, bound),
                },
              },
              { origin: "background" },
            )
            .pipe(Effect.result)
        if (Result.isFailure(adapterResult)) {
          const message = ciGateObservationErrorMessage(adapterResult.failure)
          yield* Effect.logWarning("CI Gate historical catch-up failed", {
            repositoryId: input.repository.id,
            definitionIdentity: definition.identity,
            error: message,
            historicalCoverageIncomplete: true,
            liveObservationFailed: false,
          })
          if (prior !== undefined) {
            const diagnosed = withHistoricalCoverage(prior, {
              ...coverage,
              diagnostic: `Historical catch-up stopped: ${message}`,
            })
            yield* commitProgress({
              observations: replaceObservation(diagnosed),
              sameObservationFailures: [],
              phase: "catch_up",
            })
          }
          if (isThrottle(adapterResult.failure)) {
            stopForThrottle = true
          }
          continue
        }
        const observation = adapterResult.success
        const result = observation.observations.find(
          (entry) => entry.identity === definition.identity,
        )
        if (result === undefined || result.kind !== "observed") {
          continue
        }
        const nextCoverage = applyCatchUpHistoricalCoverage({
          previous: coverage,
          runs: result.runs,
          historyExhausted:
            result.historyExhausted ??
            result.runs.length < CI_GATE_OBSERVATION_PAGE_SIZE,
        })
        const pageLatch = newestPageLatch.get(definition.identity)
        // No fresh newest-page result: do not let older history change the latch
        // or hide a live observation failure.
        if (pageLatch === undefined || pageLatch.kind === "unavailable") {
          if (prior !== undefined) {
            yield* commitProgress({
              observations: replaceObservation(
                withHistoricalCoverage(prior, nextCoverage),
              ),
              sameObservationFailures: [],
              phase: "catch_up",
            })
          }
          continue
        }
        const latched = storedLatchedFailure(prior)
        const decisiveContext = [
          ...(pageLatch.latestDecisive === null
            ? []
            : [pageLatch.latestDecisive.run]),
          ...(latched === null ? [] : [latched]),
        ]
        const applied = observationFromAdapter({
          previous: prior,
          observedAt,
          result,
          ignorePreviousLatch: branchChanged,
          retainNewerLatest: true,
          ...(decisiveContext.length === 0 ? {} : { decisiveContext }),
        })
        yield* commitProgress({
          observations: replaceObservation(
            withHistoricalCoverage(applied.observation, nextCoverage),
          ),
          sameObservationFailures:
            applied.sameObservationResolvedFailure === null
              ? []
              : [
                  {
                    identity: definition.identity,
                    run: applied.sameObservationResolvedFailure,
                  },
                ],
          phase: "catch_up",
        })
      }
    }
  },
)

export const observeRepositoryCiGate = Effect.fn("observeRepositoryCiGate")(
  function* (input: {
    readonly repository: RepositoryRecord
    readonly origin: ForgeOperationOrigin
  }) {
    yield* observeRepositoryCiGateBody(input)
    const lifecycle = yield* WorkItemLifecycle
    // Every successful observation, including the first after startup.
    // The method cannot fail the caller.
    yield* lifecycle.considerAutomaticCiRepair(input.repository.id)
  },
)

const commitWithIncidents = Effect.fn("commitCiGateIncidents")(
  function* (input: {
    readonly repository: RepositoryRecord
    readonly defaultBranch: string | null
    readonly observedAt: Date
    readonly definitions: readonly CiGateDefinitionRecord[]
    readonly previous: CiGateSnapshotRecord
    readonly observations: readonly CiGateDefinitionObservationRecord[]
    readonly removedIdentities: readonly string[]
    readonly sameObservationFailures: readonly {
      readonly identity: string
      readonly run: CiGateObservedRun
    }[]
    readonly recoveryIfCleared: CiGateRecoveryReason
    readonly previousStatus: RepositoryCiGateStatus
  }) {
    const db = yield* DbService
    const latched = input.observations.filter(
      (observation) => observation.failureLatched,
    )
    const nowClosed = latched.length > 0
    const wasClosed = input.previous.observations.some(
      (observation) => observation.failureLatched,
    )
    const incidentsToUpsert: CiFailureIncidentRecord[] = []
    const repositoryId = input.repository.id

    const definitionEntries = (identities: readonly string[]) =>
      identities.map((identity) => {
        const selected = input.definitions.find(
          (definition) => definition.identity === identity,
        )
        const observation = input.observations.find(
          (entry) => entry.identity === identity,
        )
        const failure = input.sameObservationFailures.find(
          (entry) => entry.identity === identity,
        )
        return {
          identity,
          displayLabel: selected?.displayLabel ?? identity,
          firstFailedRunIdentity:
            failure?.run.runIdentity ??
            observation?.latchedRunIdentity ??
            observation?.lastRunIdentity ??
            null,
          firstFailedRunHtmlUrl:
            failure?.run.htmlUrl ??
            observation?.latchedRunHtmlUrl ??
            observation?.lastRunHtmlUrl ??
            null,
          joinedAt: input.observedAt,
        }
      })

    if (
      input.recoveryIfCleared === "default_branch_changed" &&
      input.previous.activeIncident !== null
    ) {
      incidentsToUpsert.push(
        copyIncident(input.previous.activeIncident, {
          status: "resolved",
          resolvedAt: input.observedAt,
          recoveryReason: "default_branch_changed",
          summary: "CI Gate recovered: default branch changed.",
        }),
      )
    }

    if (nowClosed) {
      const latchedIdentities = latched.map(
        (observation) => observation.identity,
      )
      const openOnNewBranch =
        input.recoveryIfCleared === "default_branch_changed"
      if (
        input.previous.activeIncident === null ||
        !wasClosed ||
        openOnNewBranch
      ) {
        incidentsToUpsert.push({
          id: incidentId(),
          repositoryId,
          status: "open",
          openedAt: input.observedAt,
          resolvedAt: null,
          recoveryReason: null,
          summary: `CI Gate closed: ${labelsFor(latchedIdentities, input.definitions)} failed.`,
          definitions: definitionEntries(latchedIdentities),
        })
      } else {
        const existing = new Set(
          input.previous.activeIncident.definitions.map(
            (definition) => definition.identity,
          ),
        )
        const joined = latchedIdentities.filter(
          (identity) => !existing.has(identity),
        )
        incidentsToUpsert.push(
          copyIncident(input.previous.activeIncident, {
            summary: `CI Gate closed: ${labelsFor(latchedIdentities, input.definitions)} failed.`,
            definitions: [
              ...input.previous.activeIncident.definitions,
              ...definitionEntries(joined),
            ],
          }),
        )
      }
    } else if (
      wasClosed &&
      input.previous.activeIncident !== null &&
      input.recoveryIfCleared !== "default_branch_changed"
    ) {
      const reasonSummary: Record<CiGateRecoveryReason, string> = {
        newer_success: `CI Gate recovered: newer success on ${labelsFor(
          input.previous.activeIncident.definitions.map(
            (definition) => definition.identity,
          ),
          input.definitions,
        )}.`,
        definition_removed: "CI Gate recovered: CI Gate Definition removed.",
        empty_selection: "CI Gate recovered: CI Gate selection cleared.",
        default_branch_changed: "CI Gate recovered: default branch changed.",
      }
      incidentsToUpsert.push(
        copyIncident(input.previous.activeIncident, {
          status: "resolved",
          resolvedAt: input.observedAt,
          recoveryReason: input.recoveryIfCleared,
          summary: reasonSummary[input.recoveryIfCleared],
        }),
      )
    } else if (
      input.sameObservationFailures.length > 0 &&
      input.previous.activeIncident === null
    ) {
      const identities = input.sameObservationFailures.map(
        (entry) => entry.identity,
      )
      incidentsToUpsert.push({
        id: incidentId(),
        repositoryId,
        status: "resolved",
        openedAt:
          input.sameObservationFailures[0]?.run.createdAt ?? input.observedAt,
        resolvedAt: input.observedAt,
        recoveryReason: "newer_success",
        summary: `CI Gate recovered: newer success on ${labelsFor(identities, input.definitions)}.`,
        definitions: definitionEntries(identities),
      })
    }

    yield* db.commitCiGateSnapshot({
      repositoryId: input.repository.id,
      defaultBranch: input.defaultBranch,
      lastObservedAt: input.observedAt,
      observations: input.observations,
      incidentsToUpsert,
    })

    const nextStatus = deriveRepositoryCiGateStatus({
      selectedCount: input.definitions.length,
      observations: input.observations,
    })
    if (nextStatus !== input.previousStatus) {
      yield* Effect.logInfo("Repository CI Gate status changed", {
        repositoryId: input.repository.id,
        from: input.previousStatus,
        status: nextStatus,
      })
    }
    yield* wakeMergeHoldsIfGateNotClosed(input.repository.id, nextStatus)
  },
)
