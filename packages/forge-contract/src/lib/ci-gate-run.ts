import type { CiGateObservedRun } from "./types.js"

const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "failed",
  "partiallysucceeded",
])

const SUCCESS_CONCLUSIONS = new Set(["success", "succeeded"])

const NON_DECISIVE_STATUSES = new Set([
  "canceled",
  "cancelled",
  "skipped",
  "manual",
])

export type CiGateObservedRunKind =
  | "failure"
  | "success"
  | "pending"
  | "non_decisive"

/**
 * Classify one Forge-neutral CI Gate run. Provider order, not wall-clock
 * completion, is what callers use to decide newer vs older.
 */
export const classifyCiGateObservedRun = (
  run: CiGateObservedRun,
): CiGateObservedRunKind => {
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
  // GitHub: the first failed job of a still-running run is a failure.
  // The run's own status stays non-terminal until it finishes.
  if (run.earlyJobFailure === true) {
    return "failure"
  }
  return "pending"
}

/**
 * Zero-padded Forge order key. Higher run id is newer; the same id with a
 * higher attempt (GitHub rerun, GitLab iid) is newer. Callers compare the
 * strings and must not sort opaque run identities.
 */
export const ciGateRunOrderKey = (runId: number, attempt = 1): string =>
  `${String(runId).padStart(20, "0")}:${String(Math.max(attempt, 1)).padStart(6, "0")}`

/** Negative when left is older, positive when left is newer, zero when equal. */
export const compareCiGateRunOrder = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

export const isDecisiveCiGateObservedRun = (
  run: CiGateObservedRun,
): boolean => {
  const kind = classifyCiGateObservedRun(run)
  return kind === "failure" || kind === "success"
}
