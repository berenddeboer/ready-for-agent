import {
  type CiGateStatusStoryView,
  type CiGateStoryInput,
  formatIncidentDate,
  formatIncidentDateTime,
  formatRelativeTimestamp,
  presentCiGateStory,
} from "./ci-gate-status-story.js"
import { useNowMs } from "./live-duration.js"
import { ui } from "./ui.js"

const ExactTime = ({
  iso,
  children,
}: {
  readonly iso: string
  readonly children: string
}) => (
  <time dateTime={iso} title={iso}>
    {children}
    <span className="sr-only"> ({iso})</span>
  </time>
)

const RelativeTime = ({
  label,
  iso,
  nowMs,
  unavailable,
}: {
  readonly label: string
  readonly iso: string | null
  readonly nowMs: number
  readonly unavailable?: string
}) => {
  if (iso === null) {
    return unavailable === undefined ? null : (
      <span className={ui.dialogFieldHint}>
        {label}: {unavailable}
      </span>
    )
  }
  const relative = formatRelativeTimestamp(iso, nowMs)
  return (
    <span className={ui.dialogFieldHint}>
      {label}:{" "}
      {relative === null ? (
        <ExactTime iso={iso}>{iso}</ExactTime>
      ) : (
        <ExactTime iso={iso}>{relative}</ExactTime>
      )}
    </span>
  )
}

const runLinkRole = (
  run: Extract<CiGateStatusStoryView, { kind: "status" }>["runs"][number],
): string => {
  if (run.role !== "CI rerun") {
    return run.role
  }
  return run.pace === "running" ? "CI rerun · in progress" : "CI rerun · queued"
}

const RunLink = ({
  role,
  definitionLabel,
  htmlUrl,
}: {
  readonly role: string
  readonly definitionLabel: string | null
  readonly htmlUrl: string | null
}) => {
  const name =
    definitionLabel === null || definitionLabel === ""
      ? role
      : `${role} · ${definitionLabel}`
  if (htmlUrl === null || htmlUrl === "") {
    return (
      <span className={ui.dialogFieldHint}>{name}: run link unavailable</span>
    )
  }
  return (
    <span className={ui.dialogFieldHint}>
      {name}:{" "}
      <a href={htmlUrl} rel="noreferrer" target="_blank">
        View run
      </a>
    </span>
  )
}

const HistoryList = ({
  view,
}: {
  readonly view: Extract<CiGateStatusStoryView, { kind: "status" }>
}) => {
  if (view.history.length === 0 && view.earlierRuns.length === 0) {
    return null
  }
  return (
    <details data-testid="ci-gate-resolved-history">
      <summary className={ui.dialogFieldHint}>
        {view.history.length === 0
          ? "Earlier runs"
          : "Resolved incidents from the last 7 days"}
      </summary>
      {view.history.map((incident) => (
        <div key={incident.id}>
          <span className={ui.dialogFieldHint}>
            Resolved{" "}
            {incident.resolvedAt === null ? (
              "date unavailable"
            ) : (
              <ExactTime iso={incident.resolvedAt}>
                {formatIncidentDate(incident.resolvedAt)}
              </ExactTime>
            )}
            {" · "}
            Opened{" "}
            <ExactTime iso={incident.openedAt}>
              {formatIncidentDate(incident.openedAt)}
            </ExactTime>
          </span>
          <span className={ui.dialogFieldHint}>{incident.summary}</span>
          {incident.runs.map((run) => (
            <RunLink
              key={`${incident.id}-${run.label}-${run.htmlUrl ?? "none"}`}
              role={run.label}
              definitionLabel={null}
              htmlUrl={run.htmlUrl}
            />
          ))}
        </div>
      ))}
      {view.earlierRuns.map((run) => (
        <div key={`${run.label}-${run.htmlUrl ?? "none"}`}>
          <span className={ui.dialogFieldHint}>{run.label}</span>
          {run.occurredAt === null ? null : (
            <span className={ui.dialogFieldHint}>
              <ExactTime iso={run.occurredAt}>
                {formatIncidentDate(run.occurredAt)}
              </ExactTime>
            </span>
          )}
          {run.htmlUrl === null ? (
            <span className={ui.dialogFieldHint}>run link unavailable</span>
          ) : (
            <a href={run.htmlUrl} rel="noreferrer" target="_blank">
              View run
            </a>
          )}
        </div>
      ))}
    </details>
  )
}

export function CiGateStatusStory({
  ciGate,
  nowMs,
  repairPending = false,
  onStartRepair,
}: {
  readonly ciGate: CiGateStoryInput
  readonly nowMs?: number
  readonly repairPending?: boolean
  readonly onStartRepair?: () => void
}) {
  const liveNow = useNowMs(nowMs === undefined)
  const now = nowMs ?? liveNow
  const view = presentCiGateStory(ciGate, { nowMs: now })
  if (view.kind === "disabled") {
    return "CI disabled"
  }
  const repair =
    view.repair.kind === "in_progress" ? (
      <span
        className="flex min-w-0 flex-col gap-1"
        data-testid="ci-gate-repair"
      >
        <strong>Repair in progress</strong>
        <span className={ui.dialogFieldHint}>
          {view.repair.stateLabel}
          {view.repair.statusLabel === ""
            ? ""
            : ` · ${view.repair.statusLabel}`}
        </span>
        {view.repair.htmlUrl === null ? (
          <span className={ui.dialogFieldHint}>
            Repair run link unavailable
          </span>
        ) : (
          <a
            href={view.repair.htmlUrl}
            rel="noreferrer"
            target="_blank"
            data-testid="ci-repair-view"
          >
            View repair
          </a>
        )}
      </span>
    ) : view.repair.kind === "can_start" && onStartRepair !== undefined ? (
      <button
        type="button"
        className={ui.plateMini}
        data-testid="ci-repair-action"
        disabled={repairPending}
        aria-busy={repairPending || undefined}
        onClick={onStartRepair}
      >
        {repairPending ? "Starting..." : "Start CI Repair"}
      </button>
    ) : null

  return (
    <div className="flex min-w-0 flex-col gap-1 break-words">
      <strong data-testid="ci-gate-status">{view.headline}</strong>
      <span className={ui.dialogFieldHint} data-testid="ci-gate-explanation">
        {view.explanation}
      </span>
      {view.currentIncident === null ? null : (
        <span
          className="flex min-w-0 flex-col gap-1"
          data-testid="ci-gate-current-incident"
        >
          <strong>Current incident</strong>
          {view.currentIncident.openedAt === null ? (
            <span className={ui.dialogFieldHint}>
              Incident opened: unavailable
            </span>
          ) : (
            <span className={ui.dialogFieldHint}>
              Incident opened:{" "}
              <ExactTime iso={view.currentIncident.openedAt}>
                {formatIncidentDateTime(view.currentIncident.openedAt) ??
                  view.currentIncident.openedAt}
              </ExactTime>
            </span>
          )}
        </span>
      )}
      {repair}
      {view.notes.map((note) => (
        <span key={note} className={ui.dialogFieldHint}>
          {note}
        </span>
      ))}
      {view.runs.map((run) => (
        <RunLink
          key={`${runLinkRole(run)}-${run.definitionLabel ?? "run"}-${run.htmlUrl ?? "none"}`}
          role={runLinkRole(run)}
          definitionLabel={run.definitionLabel}
          htmlUrl={run.htmlUrl}
        />
      ))}
      <RelativeTime
        label="Last checked"
        iso={view.lastCheckedAt}
        nowMs={now}
        unavailable="not yet"
      />
      {view.failureTimeUnavailable ? (
        <span className={ui.dialogFieldHint}>Failure time unavailable</span>
      ) : (
        <RelativeTime
          label="Failure detected"
          iso={view.failureDetectedAt}
          nowMs={now}
        />
      )}
      {view.resolvedHistoryEmptyLabel === null ? null : (
        <span
          className={ui.dialogFieldHint}
          data-testid="ci-gate-resolved-history-empty"
        >
          {view.resolvedHistoryEmptyLabel}
        </span>
      )}
      <HistoryList view={view} />
    </div>
  )
}
