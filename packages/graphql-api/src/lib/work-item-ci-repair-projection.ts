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
      return "IMPLEMENT_CI_REPAIR"
    case "authorize_as_ci_repair":
      return "AUTHORIZE_AS_CI_REPAIR"
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

export const projectWorkItemCiRepair = (input: {
  readonly workItem: WorkItemRecord
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
  const canAuthorize =
    isUnfinishedWorkItem(input.workItem) &&
    input.gateStatus === "closed" &&
    input.activeIncidentId !== null &&
    active === null
  return {
    active,
    history,
    canAuthorize,
  }
}
