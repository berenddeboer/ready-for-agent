import {
  type RepositoryCiGateStatus,
  ciGateStatusLabel,
} from "./ci-gate-status-label.js"
import { ui } from "./ui.js"

type RepositoryCiGateCard = {
  readonly status: RepositoryCiGateStatus
  readonly diagnostic: string | null
  readonly observedAt: string | null
  readonly defaultBranch: string | null
  readonly definitions: readonly {
    readonly identity: string
    readonly displayLabel: string
    readonly diagnostic: string | null
    readonly latestRun: {
      readonly rawConclusion: string | null
      readonly htmlUrl: string | null
    } | null
  }[]
  readonly activeIncident: { readonly summary: string } | null
  readonly latestResolvedIncident: { readonly summary: string } | null
}

export function RepositoryCiGateCardDetails({
  ciGate,
}: {
  readonly ciGate: RepositoryCiGateCard
}) {
  const statusLabel = ciGateStatusLabel(ciGate.status)
  if (ciGate.status === "DISABLED") {
    return statusLabel
  }
  return (
    <>
      {statusLabel}
      {ciGate.diagnostic !== null ? (
        <span className={ui.dialogFieldHint}>{ciGate.diagnostic}</span>
      ) : null}
      {ciGate.observedAt !== null ? (
        <span className={ui.dialogFieldHint}>
          Observed {ciGate.observedAt}
          {ciGate.defaultBranch !== null ? ` on ${ciGate.defaultBranch}` : ""}
        </span>
      ) : null}
      {ciGate.definitions.map((definition) => (
        <span key={definition.identity} className={ui.dialogFieldHint}>
          {definition.displayLabel}
          {definition.latestRun?.rawConclusion !== null &&
          definition.latestRun?.rawConclusion !== undefined
            ? ` · ${definition.latestRun.rawConclusion}`
            : definition.diagnostic !== null
              ? ` · ${definition.diagnostic}`
              : ""}
          {definition.latestRun?.htmlUrl !== null &&
          definition.latestRun?.htmlUrl !== undefined ? (
            <>
              {" "}
              <a
                href={definition.latestRun.htmlUrl}
                rel="noreferrer"
                target="_blank"
              >
                View run
              </a>
            </>
          ) : null}
        </span>
      ))}
      {ciGate.activeIncident !== null ? (
        <span className={ui.dialogFieldHint}>
          Active incident: {ciGate.activeIncident.summary}
        </span>
      ) : null}
      {ciGate.latestResolvedIncident !== null ? (
        <span className={ui.dialogFieldHint}>
          Last resolved: {ciGate.latestResolvedIncident.summary}
        </span>
      ) : null}
    </>
  )
}
