import { classifyCiGateObservedRun } from "@ready-for-agent/forge-contract"

/** Sentinel Issue identity stored on a CI Repair Work Item. Not a live Issue. */
export const CI_REPAIR_ISSUE_NUMBER = 0
export const CI_REPAIR_ISSUE_NATIVE_ID = "ci-repair"

export interface CiRepairFailingRun {
  readonly runIdentity: string
  readonly htmlUrl: string | null
  readonly displayLabel: string
  /** Selected CI Gate Definition. Omitted on rows written before baseline tracking. */
  readonly definitionIdentity?: string
  /** Forge run order captured when the Work Item started. */
  readonly orderKey?: string
}

export const serializeCiRepairFailingRuns = (
  runs: readonly CiRepairFailingRun[],
): string => JSON.stringify(runs)

export const parseCiRepairFailingRuns = (
  raw: string | null | undefined,
): readonly CiRepairFailingRun[] => {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.flatMap((item) => {
      if (typeof item !== "object" || item === null) {
        return []
      }
      const record = item as Record<string, unknown>
      if (
        typeof record["runIdentity"] !== "string" ||
        record["runIdentity"].trim() === ""
      ) {
        return []
      }
      const displayLabel =
        typeof record["displayLabel"] === "string" &&
        record["displayLabel"].trim() !== ""
          ? record["displayLabel"]
          : record["runIdentity"]
      const htmlUrl =
        typeof record["htmlUrl"] === "string" && record["htmlUrl"].trim() !== ""
          ? record["htmlUrl"]
          : null
      const definitionIdentity =
        typeof record["definitionIdentity"] === "string" &&
        record["definitionIdentity"].trim() !== ""
          ? record["definitionIdentity"]
          : undefined
      const orderKey =
        typeof record["orderKey"] === "string" &&
        record["orderKey"].trim() !== ""
          ? record["orderKey"]
          : undefined
      return [
        {
          runIdentity: record["runIdentity"],
          htmlUrl,
          displayLabel,
          ...(definitionIdentity === undefined ? {} : { definitionIdentity }),
          ...(orderKey === undefined ? {} : { orderKey }),
        },
      ]
    })
  } catch {
    return []
  }
}

export const ciRepairIssueTitle = (defaultBranch: string): string =>
  `Repair CI on ${defaultBranch}`

/**
 * A latched failure still qualifies when it is older than the newest run.
 * The newest run itself qualifies when it is a terminal failure, or when
 * GitHub has already seen a failed job in that still-running run.
 */
export const observationQualifiesForAutomaticCiRepair = (input: {
  readonly failureLatched: boolean
  readonly latchedRunIdentity: string | null
  readonly lastRunIdentity: string | null
  readonly lastRawStatus: string | null
  readonly lastRawConclusion: string | null
  readonly earlyJobFailure?: boolean
}): boolean => {
  if (!input.failureLatched) {
    return false
  }
  const latched = input.latchedRunIdentity?.trim() ?? ""
  const last = input.lastRunIdentity?.trim() ?? ""
  if (latched !== "" && latched !== last) {
    return true
  }
  if (input.earlyJobFailure === true) {
    return true
  }
  return (
    classifyCiGateObservedRun({
      runIdentity: last,
      htmlUrl: null,
      headSha: null,
      headRef: null,
      event: "",
      createdAt: new Date(0),
      updatedAt: null,
      startedAt: null,
      rawStatus: input.lastRawStatus,
      rawConclusion: input.lastRawConclusion,
    }) === "failure"
  )
}

const failingRunLines = (
  runs: readonly CiRepairFailingRun[],
): readonly string[] =>
  runs.map((run) =>
    run.htmlUrl === null
      ? `- ${run.displayLabel} (${run.runIdentity})`
      : `- ${run.displayLabel}: ${run.htmlUrl}`,
  )

/**
 * Implement prompt for a CI Repair Work Item. Read-only CI. No Issue.
 */
export const buildCiRepairImplementPrompt = (input: {
  readonly defaultBranch: string
  readonly headSha: string | null
  readonly failingRuns: readonly CiRepairFailingRun[]
  readonly mode: "start" | "continue"
}): string => {
  const since =
    input.headSha === null ? "the last green run" : `commit ${input.headSha}`
  return [
    input.mode === "start"
      ? `Default-branch CI on ${input.defaultBranch} has been red since the CI Repair Baseline (or ${since}).`
      : `Continue repairing default-branch CI on ${input.defaultBranch}. A previous attempt was interrupted or failed; resume from the existing session and worktree state.`,
    "Inspect the failing runs and fix the causes.",
    "Failing runs:",
    ...(input.failingRuns.length === 0
      ? ["- No failing-run link was captured. Inspect the Repository CI gate."]
      : failingRunLines(input.failingRuns)),
    "Read CI logs yourself. You have read-only access to CI. Do not rerun, cancel, or otherwise mutate CI jobs; the harness reruns jobs only when you report a No-Change Outcome that names them.",
    "Do not create or close an Issue. Keep the completion summary on this Work Item.",
    "Make the implementation in this worktree and run appropriate verification.",
    "Deliver the smallest change that fixes the failing CI. Existing upstream limitations and speculative hardening are follow-up observations, not new requirements.",
    "Run appropriate verification; the harness owns the full review cycle. Do not launch your own full-worktree reviews.",
  ].join("\n")
}

/**
 * No-Change confirmation for a CI Repair Work Item only.
 * Ordinary Issues keep buildNoChangeConfirmationPrompt.
 */
export const buildCiRepairNoChangeConfirmationPrompt = (): string =>
  [
    "The worktree and branch appear unchanged since this CI Repair Work Item started.",
    "Confirm whether that absence of repository changes is intentional.",
    "Do not edit files, commit, push, open pull requests, rerun CI, or perform other repository work during this classification.",
    "If repository changes are still required or you believe changes exist, end with READY_FOR_AGENT_RESULT: CHANGES.",
    "If CI is already fixed and this Work Item should wait, write a concise Markdown completion summary, then end with READY_FOR_AGENT_RESULT: NO_CHANGES.",
    "If specific failing runs should be rerun and no repository change is required, write a concise Markdown completion summary, then end with READY_FOR_AGENT_RESULT: RERUN_JOBS: followed by one or more run identities separated by spaces.",
    "End your final response with exactly one machine-readable result line:",
    "READY_FOR_AGENT_RESULT: CHANGES",
    "or",
    "READY_FOR_AGENT_RESULT: NO_CHANGES",
    "or",
    "READY_FOR_AGENT_RESULT: RERUN_JOBS: <runIdentity> ...",
  ].join("\n")

export type CiRepairNoChangeParse =
  | { readonly _tag: "changes" }
  | { readonly _tag: "no_changes"; readonly completionSummary: string }
  | {
      readonly _tag: "rerun_jobs"
      readonly completionSummary: string
      readonly runIdentities: readonly string[]
    }

/** Parse Assess Changes output, including the CI-repair-only rerun outcome. */
export const parseCiRepairNoChangeResult = (
  output: string,
): CiRepairNoChangeParse | null => {
  const lines = output.split("\n").map((line) => line.trim())
  const nonEmptyLines = lines.filter((line) => line !== "")
  const resultLines = lines.filter((line) =>
    /^READY_FOR_AGENT_RESULT:/i.test(line),
  )
  const finalLine = nonEmptyLines.at(-1)
  if (
    resultLines.length !== 1 ||
    finalLine === undefined ||
    finalLine !== resultLines[0]
  ) {
    return null
  }
  if (/^READY_FOR_AGENT_RESULT:\s*CHANGES$/i.test(finalLine)) {
    return { _tag: "changes" }
  }
  if (/^READY_FOR_AGENT_RESULT:\s*NO_CHANGES$/i.test(finalLine)) {
    const completionSummary = nonEmptyLines.slice(0, -1).join("\n").trim()
    if (completionSummary === "") {
      return null
    }
    return { _tag: "no_changes", completionSummary }
  }
  const rerun = /^READY_FOR_AGENT_RESULT:\s*RERUN_JOBS:\s*(.+)$/i.exec(
    finalLine,
  )
  if (rerun === null) {
    return null
  }
  const runIdentities = (rerun[1] ?? "")
    .split(/[\s,]+/)
    .map((identity) => identity.trim())
    .filter((identity) => identity !== "")
  const completionSummary = nonEmptyLines.slice(0, -1).join("\n").trim()
  if (runIdentities.length === 0 || completionSummary === "") {
    return null
  }
  return { _tag: "rerun_jobs", completionSummary, runIdentities }
}
