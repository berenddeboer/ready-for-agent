import {
  type CiGateObservedRun,
  classifyCiGateObservedRun,
  compareCiGateRunOrder,
  isResolvedCiFailureIncidentWithinHistoryWindow,
} from "@ready-for-agent/forge-contract"

type CiGateStoryRun = {
  readonly runIdentity: string
  readonly htmlUrl: string | null
  readonly rawStatus: string | null
  readonly rawConclusion: string | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly orderKey: string | null
  readonly earlyJobFailure: boolean
}

type CiGateStoryFailingRun = {
  readonly runIdentity: string
  readonly htmlUrl: string | null
  readonly orderKey: string | null
  readonly detectedAt: string | null
}

type CiGateStoryIncidentRun = {
  readonly definitionIdentity: string
  readonly displayLabel: string
  readonly runIdentity: string | null
  readonly htmlUrl: string | null
}

export type CiGateStoryIncident = {
  readonly id: string
  readonly openedAt: string
  readonly resolvedAt: string | null
  readonly summary: string
  readonly failedRuns: readonly CiGateStoryIncidentRun[]
}

export type CiGateStoryInput = {
  readonly status: "DISABLED" | "OPEN" | "CLOSED" | "DEGRADED"
  readonly observedAt: string | null
  readonly defaultBranch: string | null
  readonly diagnostic: string | null
  readonly definitions: readonly {
    readonly identity: string
    readonly displayLabel: string
    readonly failureLatched: boolean
    readonly diagnostic: string | null
    readonly latestRun: CiGateStoryRun | null
    readonly failingRun: CiGateStoryFailingRun | null
  }[]
  readonly activeIncident: {
    readonly id: string
    readonly openedAt: string
  } | null
  readonly incidentHistory: readonly CiGateStoryIncident[]
  readonly activeRepair: {
    readonly workItemId: string
    readonly stateLabel: string
    readonly statusLabel: string
    readonly htmlUrl: string | null
  } | null
  readonly canStartCiRepair: boolean
}

type RecoveryPace = "queued" | "running"

type CiGateStoryLink =
  | {
      readonly role: "Failing CI" | "Repair run" | "Recovery verification"
      readonly definitionLabel: string | null
      readonly htmlUrl: string | null
    }
  | {
      readonly role: "CI rerun"
      readonly definitionLabel: string | null
      readonly htmlUrl: string | null
      readonly pace: RecoveryPace
    }

type CiGateHistoryEntry = {
  readonly id: string
  readonly openedAt: string
  readonly resolvedAt: string | null
  readonly summary: string
  readonly runs: readonly {
    readonly label: string
    readonly htmlUrl: string | null
  }[]
}

export type CiGateStatusStoryView =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "status"
      readonly headline: string
      readonly explanation: string
      readonly repair:
        | {
            readonly kind: "in_progress"
            readonly stateLabel: string
            readonly statusLabel: string
            readonly htmlUrl: string | null
          }
        | { readonly kind: "can_start" }
        | { readonly kind: "none" }
      readonly runs: readonly CiGateStoryLink[]
      readonly notes: readonly string[]
      readonly currentIncident: {
        readonly id: string
        readonly openedAt: string | null
      } | null
      readonly failureDetectedAt: string | null
      readonly failureTimeUnavailable: boolean
      readonly lastCheckedAt: string | null
      readonly resolvedHistoryEmptyLabel: string | null
      readonly history: readonly CiGateHistoryEntry[]
      readonly earlierRuns: readonly {
        readonly label: string
        readonly htmlUrl: string | null
        readonly occurredAt: string | null
      }[]
    }

const runIdFromIdentity = (identity: string): string => {
  const separator = identity.indexOf(":")
  return separator === -1 ? identity : identity.slice(0, separator)
}

const isSameObservedRun = (left: string, right: string): boolean =>
  left === right || runIdFromIdentity(left) === runIdFromIdentity(right)

const hasText = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value.trim() !== ""

const joinLabels = (labels: readonly string[]): string => {
  if (labels.length === 0) {
    return "CI"
  }
  if (labels.length === 1) {
    return labels[0] ?? "CI"
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`
  }
  const last = labels[labels.length - 1]
  return `${labels.slice(0, -1).join(", ")}, and ${last}`
}

const branchPhrase = (branch: string | null): string =>
  hasText(branch) ? ` on ${branch}` : ""

const parseTime = (iso: string | null): number | null => {
  if (!hasText(iso)) {
    return null
  }
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? null : parsed
}

const classifyLatest = (
  run: CiGateStoryRun,
): "failure" | "success" | "pending" | "non_decisive" => {
  const observed: CiGateObservedRun = {
    runIdentity: run.runIdentity,
    htmlUrl: run.htmlUrl,
    headSha: null,
    headRef: null,
    event: "",
    createdAt: new Date(run.createdAt ?? 0),
    updatedAt: run.updatedAt === null ? null : new Date(run.updatedAt),
    startedAt: null,
    rawStatus: run.rawStatus,
    rawConclusion: run.rawConclusion,
    ...(run.orderKey === null ? {} : { orderKey: run.orderKey }),
    earlyJobFailure: run.earlyJobFailure,
  }
  return classifyCiGateObservedRun(observed)
}

const latchIsNewer = (
  failing: CiGateStoryFailingRun | null,
  latest: CiGateStoryRun,
): boolean | null => {
  if (!hasText(failing?.orderKey) || !hasText(latest.orderKey)) {
    return null
  }
  return compareCiGateRunOrder(failing.orderKey, latest.orderKey) > 0
}

/**
 * A GitHub rerun keeps the workflow run id and raises the attempt. That is
 * newer only when the order key says so. A missing key is not proof.
 */
const newerAttemptThanLatch = (
  failing: CiGateStoryFailingRun | null,
  latest: CiGateStoryRun,
): boolean => {
  if (!hasText(failing?.runIdentity) || !hasText(latest.runIdentity)) {
    return false
  }
  if (failing.runIdentity === latest.runIdentity) {
    return false
  }
  if (
    runIdFromIdentity(failing.runIdentity) !==
    runIdFromIdentity(latest.runIdentity)
  ) {
    return false
  }
  if (!hasText(failing.orderKey) || !hasText(latest.orderKey)) {
    return false
  }
  return compareCiGateRunOrder(latest.orderKey, failing.orderKey) > 0
}

const recoveryPace = (rawStatus: string | null): RecoveryPace | null => {
  const status = (rawStatus ?? "").trim().toLowerCase()
  if (
    status === "in_progress" ||
    status === "inprogress" ||
    status === "running"
  ) {
    return "running"
  }
  if (
    status === "queued" ||
    status === "pending" ||
    status === "requested" ||
    status === "waiting" ||
    status === "notstarted" ||
    status === "created" ||
    status === "preparing" ||
    status === "scheduled" ||
    status === "waiting_for_resource" ||
    status === "postponed"
  ) {
    return "queued"
  }
  return null
}

const pendingRerunPace = (
  failing: CiGateStoryFailingRun | null,
  latest: CiGateStoryRun,
): RecoveryPace | null => {
  if (!newerAttemptThanLatch(failing, latest)) {
    return null
  }
  if (classifyLatest(latest) !== "pending") {
    return null
  }
  return recoveryPace(latest.rawStatus)
}

const uniformRecoveryPace = (
  reruns: readonly { readonly pace: RecoveryPace }[],
): RecoveryPace | null => {
  const pace = reruns[0]?.pace
  if (pace === undefined || !reruns.every((rerun) => rerun.pace === pace)) {
    return null
  }
  return pace
}

const uniformRecoveryMessage = (pace: RecoveryPace): string =>
  pace === "running"
    ? "CI rerun in progress; waiting for recovery."
    : "CI rerun queued; waiting for recovery."

const namedRecoveryMessage = (
  reruns: readonly { readonly label: string; readonly pace: RecoveryPace }[],
): string => {
  const running = reruns
    .filter((rerun) => rerun.pace === "running")
    .map((rerun) => rerun.label)
  const queued = reruns
    .filter((rerun) => rerun.pace === "queued")
    .map((rerun) => rerun.label)
  const parts: string[] = []
  if (running.length > 0) {
    parts.push(`CI rerun in progress on ${joinLabels(running)}`)
  }
  if (queued.length > 0) {
    parts.push(`CI rerun queued on ${joinLabels(queued)}`)
  }
  return `${parts.join("; ")}; waiting for recovery.`
}

const predatesIncident = (
  run: CiGateStoryRun,
  openedAt: string | null | undefined,
): boolean => {
  const runAt = parseTime(run.createdAt)
  const opened = parseTime(openedAt ?? null)
  if (runAt === null || opened === null) {
    return false
  }
  return runAt < opened
}

const incidentWindowContains = (
  incident: CiGateStoryIncident,
  at: number,
): boolean => {
  const opened = parseTime(incident.openedAt)
  const resolved = parseTime(incident.resolvedAt)
  if (opened === null || at < opened) {
    return false
  }
  return resolved === null || at <= resolved
}

const statusHeadline = (
  status: Exclude<CiGateStoryInput["status"], "DISABLED">,
): string => {
  switch (status) {
    case "OPEN":
      return "CI Gate · Open"
    case "CLOSED":
      return "CI Gate · Closed"
    case "DEGRADED":
      return "CI Gate · Degraded"
  }
}

const compareResolvedIncidentsDesc = (
  left: CiGateStoryIncident,
  right: CiGateStoryIncident,
): number => {
  const leftResolved = parseTime(left.resolvedAt) ?? Number.NEGATIVE_INFINITY
  const rightResolved = parseTime(right.resolvedAt) ?? Number.NEGATIVE_INFINITY
  if (rightResolved !== leftResolved) {
    return rightResolved - leftResolved
  }
  const leftOpened = parseTime(left.openedAt) ?? Number.NEGATIVE_INFINITY
  const rightOpened = parseTime(right.openedAt) ?? Number.NEGATIVE_INFINITY
  if (rightOpened !== leftOpened) {
    return rightOpened - leftOpened
  }
  if (left.id === right.id) {
    return 0
  }
  return left.id < right.id ? 1 : -1
}

/**
 * One current-status story. Run roles and history come from stored gate
 * evidence. A missing order key or timestamp is not treated as proof.
 * A newer pending attempt of a latched failure is a recovery check, not a
 * request to start repair. It does not clear the gate.
 * Resolved history is the rolling previous 7 × 24 hours. The active incident
 * is not part of that window.
 */
export const presentCiGateStory = (
  input: CiGateStoryInput,
  options: { readonly nowMs: number },
): CiGateStatusStoryView => {
  if (input.status === "DISABLED") {
    return { kind: "disabled" }
  }

  const where = branchPhrase(input.defaultBranch)
  const outstanding: string[] = []
  const notes: string[] = []
  const runs: CiGateStoryLink[] = []
  const pendingReruns: {
    readonly identity: string
    readonly label: string
    readonly pace: RecoveryPace
  }[] = []
  const earlierRuns: {
    readonly label: string
    readonly htmlUrl: string | null
    readonly occurredAt: string | null
    readonly at: number | null
  }[] = []

  for (const definition of input.definitions) {
    const label = hasText(definition.displayLabel)
      ? definition.displayLabel
      : definition.identity
    if (definition.failureLatched) {
      const failing = definition.failingRun
      runs.push({
        role: "Failing CI",
        definitionLabel: label,
        htmlUrl: hasText(failing?.htmlUrl) ? failing.htmlUrl : null,
      })
    }

    if (
      hasText(definition.diagnostic) &&
      !definition.failureLatched &&
      definition.diagnostic !== input.diagnostic &&
      input.status !== "OPEN"
    ) {
      notes.push(`${label}: ${definition.diagnostic}`)
    }

    const latest = definition.latestRun
    if (latest === null || !hasText(latest.runIdentity)) {
      continue
    }
    const failingIdentity = definition.failingRun?.runIdentity
    const sameAsLatch =
      definition.failureLatched &&
      hasText(failingIdentity) &&
      isSameObservedRun(latest.runIdentity, failingIdentity)
    if (sameAsLatch) {
      const pace =
        input.status === "CLOSED"
          ? pendingRerunPace(definition.failingRun, latest)
          : null
      if (pace !== null) {
        pendingReruns.push({
          identity: definition.identity,
          label,
          pace,
        })
        runs.push({
          role: "CI rerun",
          definitionLabel: label,
          htmlUrl: hasText(latest.htmlUrl) ? latest.htmlUrl : null,
          pace,
        })
      } else if (
        definition.failureLatched &&
        classifyLatest(latest) === "success"
      ) {
        outstanding.push(
          `A successful result was recorded for the latched failure on ${label}, but that failure has not cleared.`,
        )
      }
      continue
    }

    if (!definition.failureLatched || input.status !== "CLOSED") {
      continue
    }

    const kind = classifyLatest(latest)
    const newerLatch = latchIsNewer(definition.failingRun, latest)
    const olderThanIncident = predatesIncident(
      latest,
      input.activeIncident?.openedAt,
    )
    if (kind === "success" && (newerLatch === true || olderThanIncident)) {
      earlierRuns.push({
        label,
        htmlUrl: latest.htmlUrl,
        occurredAt: latest.createdAt,
        at: parseTime(latest.createdAt),
      })
      continue
    }
    if (kind === "success") {
      outstanding.push(
        `A successful run was observed on ${label}, but it has not cleared the latched failure. The gate stays closed until recovery is confirmed.`,
      )
      runs.push({
        role: "Recovery verification",
        definitionLabel: label,
        htmlUrl: latest.htmlUrl,
      })
      continue
    }
    if (kind === "pending" && newerLatch !== true) {
      outstanding.push(
        `Recovery verification is still in progress on ${label}. The gate stays closed until that run succeeds.`,
      )
      runs.push({
        role: "Recovery verification",
        definitionLabel: label,
        htmlUrl: latest.htmlUrl,
      })
    }
  }

  const visibleIncidents = [...input.incidentHistory]
    .filter((incident) =>
      isResolvedCiFailureIncidentWithinHistoryWindow({
        resolvedAtMs: parseTime(incident.resolvedAt),
        nowMs: options.nowMs,
      }),
    )
    .sort(compareResolvedIncidentsDesc)

  const history = visibleIncidents.map((incident) => ({
    id: incident.id,
    openedAt: incident.openedAt,
    resolvedAt: incident.resolvedAt,
    summary: incident.summary,
    runs: [
      ...incident.failedRuns.map((run) => ({
        label: hasText(run.displayLabel)
          ? `Failing CI · ${run.displayLabel}`
          : "Failing CI",
        htmlUrl: run.htmlUrl,
      })),
      ...earlierRuns.flatMap((run) => {
        if (run.at === null || !incidentWindowContains(incident, run.at)) {
          return []
        }
        return [
          {
            label: `Successful run · ${run.label}`,
            htmlUrl: run.htmlUrl,
          },
        ]
      }),
    ],
  }))
  const attachedTimes = new Set(
    visibleIncidents.flatMap((incident) =>
      earlierRuns.flatMap((run) =>
        run.at !== null && incidentWindowContains(incident, run.at)
          ? [run.at]
          : [],
      ),
    ),
  )
  const unattached = earlierRuns.filter(
    (run) => run.at === null || !attachedTimes.has(run.at),
  )

  const recoveringIdentities = new Set(
    pendingReruns.map((rerun) => rerun.identity),
  )
  const stillFailedLabels = input.definitions
    .filter(
      (definition) =>
        definition.failureLatched &&
        !recoveringIdentities.has(definition.identity),
    )
    .map((definition) =>
      hasText(definition.displayLabel)
        ? definition.displayLabel
        : definition.identity,
    )
  const allLatchedRecovering =
    pendingReruns.length > 0 && stillFailedLabels.length === 0
  const recoveryExplanation = (): string => {
    const pace = uniformRecoveryPace(pendingReruns)
    return pace === null
      ? namedRecoveryMessage(pendingReruns)
      : uniformRecoveryMessage(pace)
  }
  const closedFailure = `${joinLabels(stillFailedLabels)} failed${where}. ${
    outstanding.length > 0
      ? outstanding.join(" ")
      : "The gate remains closed until recovery is confirmed."
  }`

  let explanation: string
  switch (input.status) {
    case "CLOSED":
      explanation = allLatchedRecovering
        ? recoveryExplanation()
        : pendingReruns.length > 0
          ? `${namedRecoveryMessage(pendingReruns)} ${closedFailure}`
          : closedFailure
      break
    case "OPEN": {
      const unobserved = input.definitions.filter(
        (definition) =>
          !definition.failureLatched && hasText(definition.diagnostic),
      )
      explanation =
        unobserved.length === 0
          ? `Default-branch CI is healthy${where}.`
          : `No failing run has been recorded${where}. ${unobserved
              .map(
                (definition) =>
                  `${
                    hasText(definition.displayLabel)
                      ? definition.displayLabel
                      : definition.identity
                  }: ${definition.diagnostic}`,
              )
              .join(" ")}`
      break
    }
    case "DEGRADED":
      explanation = hasText(input.diagnostic)
        ? input.diagnostic
        : "A selected CI Gate Definition could not be observed."
      break
  }

  const failureDetectedAt = input.definitions.find((definition) =>
    hasText(definition.failingRun?.detectedAt),
  )?.failingRun?.detectedAt
  const closed = input.status === "CLOSED"
  const incidentOpenedAt =
    closed && input.activeIncident !== null
      ? input.activeIncident.openedAt
      : null
  const knownIncidentOpenedAt =
    parseTime(incidentOpenedAt) === null ? null : incidentOpenedAt
  const currentIncident =
    closed && input.activeIncident !== null
      ? {
          id: input.activeIncident.id,
          openedAt: knownIncidentOpenedAt,
        }
      : null
  const repair =
    input.activeRepair === null
      ? input.canStartCiRepair && !allLatchedRecovering
        ? ({ kind: "can_start" } as const)
        : ({ kind: "none" } as const)
      : {
          kind: "in_progress" as const,
          stateLabel: input.activeRepair.stateLabel,
          statusLabel: input.activeRepair.statusLabel,
          htmlUrl: input.activeRepair.htmlUrl,
        }

  return {
    kind: "status",
    headline: statusHeadline(input.status),
    explanation,
    repair,
    runs,
    notes,
    currentIncident,
    failureDetectedAt: hasText(failureDetectedAt) ? failureDetectedAt : null,
    failureTimeUnavailable:
      closed && !hasText(failureDetectedAt) && knownIncidentOpenedAt === null,
    lastCheckedAt: input.observedAt,
    resolvedHistoryEmptyLabel:
      closed && visibleIncidents.length === 0
        ? "No resolved incidents in the last 7 days"
        : null,
    history,
    earlierRuns: unattached.map((run) => ({
      label: `Earlier successful run · ${run.label}`,
      htmlUrl: run.htmlUrl,
      occurredAt: run.occurredAt,
    })),
  }
}

export const formatRelativeTimestamp = (
  iso: string,
  nowMs: number,
): string | null => {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) {
    return null
  }
  const elapsed = nowMs - then
  if (elapsed < 45_000) {
    return "just now"
  }
  const minutes = Math.round(elapsed / 60_000)
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${String(minutes)} minutes ago`
  }
  const hours = Math.round(elapsed / 3_600_000)
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${String(hours)} hours ago`
  }
  const days = Math.round(elapsed / 86_400_000)
  return days === 1 ? "yesterday" : `${String(days)} days ago`
}

export const formatIncidentDate = (iso: string): string => {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) {
    return iso
  }
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(parsed))
}

const UTC_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** Visible incident opening time. Not a failing-run detection time. */
export const formatIncidentDateTime = (iso: string): string | null => {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) {
    return null
  }
  const date = new Date(parsed)
  const month = UTC_MONTHS[date.getUTCMonth()]
  if (month === undefined) {
    return null
  }
  const hours = String(date.getUTCHours()).padStart(2, "0")
  const minutes = String(date.getUTCMinutes()).padStart(2, "0")
  return `${String(date.getUTCDate())} ${month} ${String(date.getUTCFullYear())}, ${hours}:${minutes} UTC`
}
