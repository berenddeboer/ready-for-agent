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
  readonly activeIncident: {
    readonly id?: string
    readonly summary: string
  } | null
  readonly latestResolvedIncident: { readonly summary: string } | null
}

export type RepositoryCiRepairCard = {
  readonly incidentId: string
  readonly status: "QUEUED" | "RUNNING" | "RECOVERED" | "UNRESOLVED"
  readonly requestSource: "MANUAL" | "AUTOMATIC"
  readonly outcome: "RECOVERED" | "FAILED" | "TIMED_OUT" | "INTERRUPTED" | null
  readonly launchedAt: string | null
  readonly deadlineAt: string | null
  readonly report: string | null
  readonly localExecutionStopped: boolean
  readonly links: readonly {
    readonly url: string
    readonly kind: string
    readonly disposition: string
  }[]
}

const repairStatusLabel = (repair: RepositoryCiRepairCard): string => {
  switch (repair.status) {
    case "QUEUED":
      return "CI repair queued"
    case "RUNNING":
      return "CI repair running"
    case "RECOVERED":
      return "CI repair recovered"
    case "UNRESOLVED":
      switch (repair.outcome) {
        case "TIMED_OUT":
          return "CI repair timed out"
        case "INTERRUPTED":
          return "CI repair interrupted"
        default:
          return "CI repair failed"
      }
  }
}

export function RepositoryCiGateCardDetails({
  ciGate,
  repairSupported = false,
  repair = null,
  repairPending = false,
  onStartRepair,
}: {
  readonly ciGate: RepositoryCiGateCard
  readonly repairSupported?: boolean
  readonly repair?: RepositoryCiRepairCard | null
  readonly repairPending?: boolean
  readonly onStartRepair?: () => void
}) {
  const statusLabel = ciGateStatusLabel(ciGate.status)
  if (ciGate.status === "DISABLED") {
    return statusLabel
  }
  const incidentId = ciGate.activeIncident?.id
  const sameIncident =
    repair !== null &&
    incidentId !== undefined &&
    repair.incidentId === incidentId
  const inFlight =
    sameIncident && (repair.status === "QUEUED" || repair.status === "RUNNING")
  const retry = sameIncident && repair.status === "UNRESOLVED"
  const showRepairAction =
    repairSupported &&
    ciGate.status === "CLOSED" &&
    ciGate.activeIncident !== null &&
    onStartRepair !== undefined &&
    !inFlight
  const repairAction = showRepairAction ? (
    <button
      type="button"
      className={ui.plateMini}
      data-testid="ci-repair-action"
      data-ci-repair-action={retry ? "retry" : "start"}
      disabled={repairPending}
      aria-busy={repairPending || undefined}
      onClick={onStartRepair}
    >
      {repairPending
        ? "Starting..."
        : retry
          ? "Retry CI repair"
          : "Start CI repair"}
    </button>
  ) : null
  return (
    <span className="flex min-w-0 flex-col gap-1 break-words">
      <span>{statusLabel}</span>
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
      {repairSupported && repair !== null ? (
        <CiRepairStatus repair={repair} />
      ) : null}
      {repairAction}
    </span>
  )
}

function CiRepairStatus({
  repair,
}: {
  readonly repair: RepositoryCiRepairCard
}) {
  const unfinished = repair.links.filter(
    (link) =>
      link.kind === "pull_request" &&
      (link.disposition === "unfinished" || link.disposition === "unknown"),
  )
  const activeJobs = repair.links.filter(
    (link) => link.kind === "remote_job" && link.disposition === "active",
  )
  return (
    <span
      className="flex min-w-0 flex-col gap-1"
      data-testid="ci-repair-status"
    >
      <span>{repairStatusLabel(repair)}</span>
      <span data-testid="ci-repair-request-source">
        {repair.requestSource === "AUTOMATIC" ? "Automatic" : "Manual"}
      </span>
      {repair.deadlineAt !== null ? (
        <span className={ui.dialogFieldHint}>
          Deadline {repair.deadlineAt}
          {repair.launchedAt !== null ? ` · launched ${repair.launchedAt}` : ""}
        </span>
      ) : (
        <span className={ui.dialogFieldHint}>
          Deadline starts when the repair launches, not while it is queued.
        </span>
      )}
      {repair.localExecutionStopped ? (
        <span className={ui.dialogFieldHint}>Local execution stopped.</span>
      ) : null}
      {unfinished.length > 0 ? (
        <span className={ui.dialogFieldHint}>
          Unfinished pull requests:{" "}
          {unfinished.map((link) => link.url).join(", ")}
        </span>
      ) : (
        <span className={ui.dialogFieldHint}>
          Unfinished pull requests: none recorded.
        </span>
      )}
      {activeJobs.length > 0 ? (
        <span className={ui.dialogFieldHint}>
          Active remote jobs: {activeJobs.map((link) => link.url).join(", ")}
        </span>
      ) : (
        <span className={ui.dialogFieldHint}>
          Active remote jobs: none recorded.
        </span>
      )}
      {repair.links.map((link) => (
        <a key={link.url} href={link.url} rel="noreferrer" target="_blank">
          {link.url}
        </a>
      ))}
      {repair.report !== null && repair.report !== "" ? (
        <span className={ui.dialogFieldHint}>{repair.report}</span>
      ) : null}
    </span>
  )
}
