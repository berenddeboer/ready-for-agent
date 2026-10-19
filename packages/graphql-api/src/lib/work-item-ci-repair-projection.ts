import type { CiRepairAuthorizationRecord } from "@ready-for-agent/db-service"
import {
  type WorkItemRecord,
  isUnfinishedWorkItem,
} from "@ready-for-agent/work-item-lifecycle"
import { projectCiFailureIncident } from "./ci-gate-projection.js"
import type { deriveRepositoryCiGateStatus } from "./observe-repository-ci-gate.js"

const toGraphqlSourceAction = (
  sourceAction: CiRepairAuthorizationRecord["sourceAction"],
) => {
  switch (sourceAction) {
    case "implement_ci_repair":
      return "IMPLEMENT_CI_GATE_BYPASS"
    case "authorize_as_ci_repair":
      return "AUTHORIZE_CI_GATE_BYPASS"
    default: {
      const _exhaustive: never = sourceAction
      return _exhaustive
    }
  }
}

const toGraphqlAuthorization = (
  authorization: CiRepairAuthorizationRecord,
  definitions: Parameters<typeof projectCiFailureIncident>[1],
) => {
  const incident = projectCiFailureIncident(authorization.incident, definitions)
  if (incident === null) {
    return null
  }
  return {
    authorizedAt: authorization.authorizedAt.toISOString(),
    sourceAction: toGraphqlSourceAction(authorization.sourceAction),
    incident,
  }
}

/**
 * CI Gate Bypass authorization is for ordinary Work Items. A CI Repair Work
 * Item crosses a Closed gate by origin, so the authorize action stays
 * unavailable regardless of lifecycle state or gate state.
 */
const ciGateBypassCanAuthorize = (input: {
  readonly origin: WorkItemRecord["origin"]
  readonly unfinished: boolean
  readonly gateStatus: ReturnType<typeof deriveRepositoryCiGateStatus>
  readonly activeIncidentId: string | null
  readonly alreadyAuthorized: boolean
}): boolean =>
  input.origin !== "ci_repair" &&
  input.unfinished &&
  input.gateStatus === "closed" &&
  input.activeIncidentId !== null &&
  !input.alreadyAuthorized

export const projectWorkItemCiRepair = (input: {
  readonly workItem: Pick<WorkItemRecord, "origin" | "state" | "failureCode">
  readonly authorizations: readonly CiRepairAuthorizationRecord[]
  readonly definitions: Parameters<typeof projectCiFailureIncident>[1]
  readonly gateStatus: ReturnType<typeof deriveRepositoryCiGateStatus>
  readonly activeIncidentId: string | null
}) => {
  const history = input.authorizations.flatMap((authorization) => {
    const projected = toGraphqlAuthorization(authorization, input.definitions)
    return projected === null ? [] : [projected]
  })
  const active =
    input.activeIncidentId === null
      ? null
      : (history.find(
          (authorization) =>
            authorization.incident.id === input.activeIncidentId,
        ) ?? null)
  const canAuthorize = ciGateBypassCanAuthorize({
    origin: input.workItem.origin,
    unfinished: isUnfinishedWorkItem(input.workItem),
    gateStatus: input.gateStatus,
    activeIncidentId: input.activeIncidentId,
    alreadyAuthorized: active !== null,
  })
  return {
    active,
    history,
    canAuthorize,
  }
}
