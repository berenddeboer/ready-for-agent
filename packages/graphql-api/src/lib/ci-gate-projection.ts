import type {
  CiFailureIncidentRecord,
  CiGateDefinitionObservationRecord,
  CiGateDefinitionRecord,
  CiGateSnapshotRecord,
} from "@ready-for-agent/db-service"
import { deriveRepositoryCiGateStatus } from "./observe-repository-ci-gate.js"

const toGraphqlStatus = (
  status: ReturnType<typeof deriveRepositoryCiGateStatus>,
) => {
  switch (status) {
    case "disabled":
      return "DISABLED"
    case "open":
      return "OPEN"
    case "closed":
      return "CLOSED"
    case "degraded":
      return "DEGRADED"
  }
}

const toGraphqlRecoveryReason = (
  reason: CiFailureIncidentRecord["recoveryReason"],
) => {
  if (reason === null) {
    return null
  }
  switch (reason) {
    case "newer_success":
      return "NEWER_SUCCESS"
    case "definition_removed":
      return "DEFINITION_REMOVED"
    case "empty_selection":
      return "EMPTY_SELECTION"
    case "default_branch_changed":
      return "DEFAULT_BRANCH_CHANGED"
  }
}

const definitionLookup = (
  definitions: readonly CiGateDefinitionRecord[],
  identity: string,
): CiGateDefinitionRecord =>
  definitions.find((definition) => definition.identity === identity) ?? {
    identity,
    displayLabel: identity,
    kind: "unknown",
    diagnosticMetadata: null,
  }

const notObservedDiagnostic = "Not observed yet"

const observationDiagnostic = (
  observation: CiGateDefinitionObservationRecord,
): string | null => {
  if (observation.observationError !== null) {
    return observation.observationError
  }
  if (
    observation.lastRunIdentity === null &&
    observation.lastRawStatus === null &&
    observation.lastRawConclusion === null
  ) {
    return notObservedDiagnostic
  }
  return null
}

const toGraphqlLatestRun = (observation: CiGateDefinitionObservationRecord) => {
  if (
    observation.lastRunIdentity === null &&
    observation.lastRawStatus === null &&
    observation.lastRawConclusion === null
  ) {
    return null
  }
  return {
    runIdentity: observation.lastRunIdentity ?? "",
    htmlUrl: observation.lastRunHtmlUrl,
    headSha: observation.lastHeadSha,
    headRef: observation.lastHeadRef,
    event: observation.lastEvent,
    rawStatus: observation.lastRawStatus,
    rawConclusion: observation.lastRawConclusion,
    createdAt: observation.lastRunCreatedAt?.toISOString() ?? null,
    updatedAt: observation.lastRunUpdatedAt?.toISOString() ?? null,
  }
}

export const projectCiFailureIncident = (
  incident: CiFailureIncidentRecord | null,
  definitions: readonly CiGateDefinitionRecord[],
) => {
  if (incident === null) {
    return null
  }
  return {
    id: incident.id,
    status: incident.status === "open" ? "OPEN" : "RESOLVED",
    openedAt: incident.openedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    recoveryReason: toGraphqlRecoveryReason(incident.recoveryReason),
    summary: incident.summary,
    failedDefinitions: incident.definitions.map((entry) => {
      const selected = definitionLookup(definitions, entry.identity)
      return {
        identity: entry.identity,
        displayLabel: entry.displayLabel || selected.displayLabel,
        kind: selected.kind,
        diagnosticMetadata: selected.diagnosticMetadata,
      }
    }),
  }
}

const gateDiagnostic = (input: {
  readonly status: ReturnType<typeof deriveRepositoryCiGateStatus>
  readonly definitions: readonly CiGateDefinitionRecord[]
  readonly observations: readonly CiGateDefinitionObservationRecord[]
}): string | null => {
  if (input.status === "disabled") {
    return "No CI Gate Definitions selected — Repository CI Gate is disabled."
  }
  if (input.status === "closed") {
    const failed = input.observations.filter(
      (observation) => observation.failureLatched,
    )
    if (failed.length === 0) {
      return "Repository CI Gate is closed."
    }
    return `Repository CI Gate is closed: ${failed
      .map(
        (observation) =>
          input.definitions.find(
            (definition) => definition.identity === observation.identity,
          )?.displayLabel ?? observation.identity,
      )
      .join(", ")} failed.`
  }
  if (input.status === "degraded") {
    const errored = input.observations.find(
      (observation) => observation.observationError !== null,
    )
    return errored?.observationError ?? "Repository CI Gate is degraded."
  }
  return null
}

export const projectRepositoryCiGate = (input: {
  readonly definitions: readonly CiGateDefinitionRecord[]
  readonly snapshot: CiGateSnapshotRecord
}) => {
  const status = deriveRepositoryCiGateStatus({
    selectedCount: input.definitions.length,
    observations: input.snapshot.observations,
  })
  const observationsByIdentity = new Map(
    input.snapshot.observations.map((observation) => [
      observation.identity,
      observation,
    ]),
  )
  return {
    enabled: input.definitions.length > 0,
    status: toGraphqlStatus(status),
    observedAt: input.snapshot.state?.lastObservedAt?.toISOString() ?? null,
    defaultBranch: input.snapshot.state?.defaultBranch ?? null,
    diagnostic: gateDiagnostic({
      status,
      definitions: input.definitions,
      observations: input.snapshot.observations,
    }),
    definitions: input.definitions.map((definition) => {
      const observation = observationsByIdentity.get(definition.identity)
      if (observation === undefined) {
        return {
          identity: definition.identity,
          displayLabel: definition.displayLabel,
          kind: definition.kind,
          diagnosticMetadata: definition.diagnosticMetadata,
          failureLatched: false,
          latestRun: null,
          observedAt: null,
          diagnostic: notObservedDiagnostic,
        }
      }
      return {
        identity: definition.identity,
        displayLabel: definition.displayLabel,
        kind: definition.kind,
        diagnosticMetadata: definition.diagnosticMetadata,
        failureLatched: observation.failureLatched,
        latestRun: toGraphqlLatestRun(observation),
        observedAt: observation.lastObservedAt?.toISOString() ?? null,
        diagnostic: observationDiagnostic(observation),
      }
    }),
    activeIncident: projectCiFailureIncident(
      input.snapshot.activeIncident,
      input.definitions,
    ),
    latestResolvedIncident: projectCiFailureIncident(
      input.snapshot.latestResolvedIncident,
      input.definitions,
    ),
  }
}
