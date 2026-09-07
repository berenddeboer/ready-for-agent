import { Clock, Effect, Result } from "effect"
import { ulid } from "ulidx"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
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
  type CiGateDefinitionObservation,
  type CiGateObservation,
  type CiGateObservedRun,
  type GitHubOperationOrigin,
  GitHubService,
  type ObserveCiGateInput,
  formatUserFacingError,
} from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import { WorkItemLifecycle } from "@ready-for-agent/work-item-lifecycle"

export type RepositoryCiGateStatus = "disabled" | "open" | "closed" | "degraded"

const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "failed",
  "partiallysucceeded",
])

const SUCCESS_CONCLUSIONS = new Set(["success", "succeeded"])

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

const NON_DECISIVE_STATUSES = new Set([
  "canceled",
  "cancelled",
  "skipped",
  "manual",
])

const classifyRun = (
  run: CiGateObservedRun,
): "failure" | "success" | "pending" | "non_decisive" => {
  const status = (run.rawStatus ?? "").trim().toLowerCase()
  const conclusion = (run.rawConclusion ?? "").trim().toLowerCase()
  if (status === "completed") {
    if (conclusion !== "" && FAILURE_CONCLUSIONS.has(conclusion)) {
      return "failure"
    }
    if (conclusion !== "" && SUCCESS_CONCLUSIONS.has(conclusion)) {
      return "success"
    }
    return "non_decisive"
  }
  if (status === "failed" || status === "failure") {
    return "failure"
  }
  if (status === "success" || SUCCESS_CONCLUSIONS.has(conclusion)) {
    return "success"
  }
  if (NON_DECISIVE_STATUSES.has(status)) {
    return "non_decisive"
  }
  return "pending"
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
): readonly CiGateObservedRun[] => {
  if (lastRunIdentity === null) {
    return runs
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

const reduceNewlyObserved = (runs: readonly CiGateObservedRun[]) => {
  let latestDecisive: {
    readonly kind: "failure" | "success"
    readonly run: CiGateObservedRun
  } | null = null
  let olderFailure: CiGateObservedRun | null = null
  for (const run of runs) {
    const kind = classifyRun(run)
    if (kind !== "failure" && kind !== "success") {
      continue
    }
    if (latestDecisive === null) {
      latestDecisive = { kind, run }
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
  return { latestDecisive, olderFailure }
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
  observationError: input.message,
  observationErrorKind: input.reason,
})

const applyObservedRuns = (input: {
  readonly previous: CiGateDefinitionObservationRecord | undefined
  readonly identity: string
  readonly observedAt: Date
  readonly runs: readonly CiGateObservedRun[]
  readonly ignorePreviousLatch: boolean
}): {
  readonly observation: CiGateDefinitionObservationRecord
  readonly sameObservationResolvedFailure: CiGateObservedRun | null
} => {
  const lastSeen = input.ignorePreviousLatch
    ? null
    : (input.previous?.lastRunIdentity ?? null)
  const fresh = newlyObservedRuns(input.runs, lastSeen)
  const reduced = reduceNewlyObserved(fresh)
  const latest = input.runs[0]
  let failureLatched = input.ignorePreviousLatch
    ? false
    : (input.previous?.failureLatched ?? false)
  let latchedRunIdentity = input.ignorePreviousLatch
    ? null
    : (input.previous?.latchedRunIdentity ?? null)
  let latchedRunHtmlUrl = input.ignorePreviousLatch
    ? null
    : (input.previous?.latchedRunHtmlUrl ?? null)
  if (reduced.latestDecisive?.kind === "failure") {
    failureLatched = true
    latchedRunIdentity = reduced.latestDecisive.run.runIdentity
    latchedRunHtmlUrl = reduced.latestDecisive.run.htmlUrl
  } else if (reduced.latestDecisive?.kind === "success") {
    failureLatched = false
    latchedRunIdentity = null
    latchedRunHtmlUrl = null
  }
  const sameObservationResolvedFailure =
    !input.ignorePreviousLatch &&
    !(input.previous?.failureLatched ?? false) &&
    reduced.latestDecisive?.kind === "success"
      ? reduced.olderFailure
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
      lastRawConclusion:
        latest?.rawConclusion ?? previousRun?.lastRawConclusion ?? null,
      lastRunCreatedAt:
        latest?.createdAt ?? previousRun?.lastRunCreatedAt ?? null,
      lastRunUpdatedAt:
        latest?.updatedAt ?? previousRun?.lastRunUpdatedAt ?? null,
      failureLatched,
      latchedRunIdentity,
      latchedRunHtmlUrl,
      observationError: null,
      observationErrorKind: null,
    },
    sameObservationResolvedFailure,
  }
}

const observationFromAdapter = (input: {
  readonly previous: CiGateDefinitionObservationRecord | undefined
  readonly observedAt: Date
  readonly result: CiGateDefinitionObservation
  readonly ignorePreviousLatch: boolean
}): {
  readonly observation: CiGateDefinitionObservationRecord
  readonly sameObservationResolvedFailure: CiGateObservedRun | null
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
    }
  }
  return applyObservedRuns({
    previous: input.previous,
    identity: input.result.identity,
    observedAt: input.observedAt,
    runs: input.result.runs,
    ignorePreviousLatch: input.ignorePreviousLatch,
  })
}

export const observeRepositoryCiGate = Effect.fn("observeRepositoryCiGate")(
  function* (input: {
    readonly repository: RepositoryRecord
    readonly origin: GitHubOperationOrigin
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

    if (
      input.repository.forge !== "github" &&
      input.repository.forge !== "gitlab" &&
      input.repository.forge !== "azure-devops"
    ) {
      const observations = definitions.map((definition) =>
        unavailableObservation({
          previous: previousByIdentity.get(definition.identity),
          identity: definition.identity,
          observedAt,
          reason: "error",
          message: `CI Gate observation is not available for ${input.repository.forge} Repositories`,
        }),
      )
      yield* commitWithIncidents({
        repository: input.repository,
        defaultBranch: previous.state?.defaultBranch ?? null,
        observedAt,
        definitions,
        previous,
        observations,
        removedIdentities,
        sameObservationFailures: [],
        recoveryIfCleared:
          removedIdentities.length > 0 ? "definition_removed" : "newer_success",
        previousStatus,
      })
      return
    }

    const lastRunIdentities: { [definitionIdentity: string]: string } = {}
    for (const definition of definitions) {
      const last = previousByIdentity.get(definition.identity)?.lastRunIdentity
      if (last !== null && last !== undefined && last !== "") {
        lastRunIdentities[definition.identity] = last
      }
    }

    const forgeRepository = {
      forge: input.repository.forge,
      forgeHost: input.repository.forgeHost,
      projectPath: input.repository.projectPath,
    }
    const observationInput: ObserveCiGateInput = {
      definitionIdentities: definitions.map(
        (definition) => definition.identity,
      ),
      lastRunIdentities,
    }
    let adapterResult: Result.Result<CiGateObservation, unknown>
    if (input.repository.forge === "azure-devops") {
      const azureDevOps = yield* AzureDevOpsService
      adapterResult = yield* azureDevOps
        .observeCiGate(forgeRepository, observationInput)
        .pipe(Effect.result)
    } else if (input.repository.forge === "gitlab") {
      const gitlab = yield* GitLabService
      adapterResult = yield* gitlab
        .observeCiGate(forgeRepository, observationInput)
        .pipe(Effect.result)
    } else {
      const github = yield* GitHubService
      adapterResult = yield* github
        .observeCiGate(forgeRepository, observationInput, {
          origin: input.origin,
        })
        .pipe(Effect.result)
    }

    if (Result.isFailure(adapterResult)) {
      const message = ciGateObservationErrorMessage(adapterResult.failure)
      const reason = isPermissionError(adapterResult.failure)
        ? ("permission" as const)
        : ("error" as const)
      yield* Effect.logWarning("CI Gate observation failed", {
        repositoryId: input.repository.id,
        error: message,
      })
      const observations = definitions.map((definition) =>
        unavailableObservation({
          previous: previousByIdentity.get(definition.identity),
          identity: definition.identity,
          observedAt,
          reason,
          message,
        }),
      )
      yield* commitWithIncidents({
        repository: input.repository,
        defaultBranch: previous.state?.defaultBranch ?? null,
        observedAt,
        definitions,
        previous,
        observations,
        removedIdentities,
        sameObservationFailures: [],
        recoveryIfCleared:
          removedIdentities.length > 0 ? "definition_removed" : "newer_success",
        previousStatus,
      })
      return
    }

    const observation = adapterResult.success
    const defaultBranchChanged =
      previous.state?.defaultBranch !== null &&
      previous.state?.defaultBranch !== undefined &&
      previous.state.defaultBranch !== observation.defaultBranch
    const ignorePreviousLatch = defaultBranchChanged
    const sameObservationFailures: {
      readonly identity: string
      readonly run: CiGateObservedRun
    }[] = []
    const observations: CiGateDefinitionObservationRecord[] = []
    for (const definition of definitions) {
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
        previous: previousByIdentity.get(definition.identity),
        observedAt,
        result,
        ignorePreviousLatch,
      })
      observations.push(applied.observation)
      if (applied.sameObservationResolvedFailure !== null) {
        sameObservationFailures.push({
          identity: definition.identity,
          run: applied.sameObservationResolvedFailure,
        })
      }
    }

    let recoveryIfCleared: CiGateRecoveryReason = "newer_success"
    if (defaultBranchChanged) {
      recoveryIfCleared = "default_branch_changed"
    } else if (removedIdentities.length > 0) {
      const successClearedLatch = observations.some((current) => {
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
      defaultBranch: observation.defaultBranch,
      observedAt,
      definitions,
      previous,
      observations,
      removedIdentities,
      sameObservationFailures,
      recoveryIfCleared,
      previousStatus,
    })
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
