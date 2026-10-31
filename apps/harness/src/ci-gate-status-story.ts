import {
  type CiGateObservedRun,
  classifyCiGateObservedRun,
  compareCiGateRunOrder,
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

type CiGateStoryLink = {
  readonly role: "Failing CI" | "Repair run" | "Recovery verification"
  readonly definitionLabel: string | null
  readonly htmlUrl: string | null
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
      readonly failureDetectedAt: string | null
      readonly failureTimeUnavailable: boolean
      readonly lastCheckedAt: string | null
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

/**
 * One current-status story. Run roles and history come from stored gate
 * evidence. A missing order key or timestamp is not treated as proof.
 */
export const presentCiGateStory = (
  input: CiGateStoryInput,
): CiGateStatusStoryView => {
  if (input.status === "DISABLED") {
    return { kind: "disabled" }
  }

  const failedLabels = input.definitions
    .filter((definition) => definition.failureLatched)
    .map((definition) =>
      hasText(definition.displayLabel)
        ? definition.displayLabel
        : definition.identity,
    )
  const where = branchPhrase(input.defaultBranch)
  const outstanding: string[] = []
  const notes: string[] = []
  const runs: CiGateStoryLink[] = []
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
      if (definition.failureLatched && classifyLatest(latest) === "success") {
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

  const history = input.incidentHistory.map((incident) => ({
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
    input.incidentHistory.flatMap((incident) =>
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

  let explanation: string
  switch (input.status) {
    case "CLOSED":
      explanation = `${joinLabels(failedLabels)} failed${where}. ${
        outstanding.length > 0
          ? outstanding.join(" ")
          : "The gate remains closed until recovery is confirmed."
      }`
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
  const repair =
    input.activeRepair === null
      ? input.canStartCiRepair
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
    failureDetectedAt: hasText(failureDetectedAt) ? failureDetectedAt : null,
    failureTimeUnavailable: closed && !hasText(failureDetectedAt),
    lastCheckedAt: input.observedAt,
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
