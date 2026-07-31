/**
 * Archive journey-leg planning for the Completed page
 * (`docs/harness-design-system.md` §4.5 / §5.2, wayfinder #698 prototype).
 *
 * The archive is terminal Complete / Abandoned only. Legs are a condensed
 * BUILD → REVIEW → CHECKS / MERGE (or PR / NO PR NEEDED) view — not the full
 * fine-grained lifecycle chip list used on the board.
 */

import { formatDuration } from "./live-duration.js"
import {
  type LifecycleLabelChip,
  lifecycleLaneForPhase,
  sumLaneDurationMs,
} from "./pipeline-lanes.js"

export type ArchiveLegKind = "done" | "skip" | "fail"

/** CSS custom props for lane-coloured done legs. */
export type ArchiveLegLane = "build" | "review" | "pr"

export type ArchiveLeg = {
  readonly id: string
  readonly label: string
  readonly kind: ArchiveLegKind
  readonly durationMs: number | null
  /** Lane colour for done legs; fail always uses Attention. */
  readonly lane: ArchiveLegLane | null
}

export type ArchiveWorkItemInput = {
  readonly status: string
  readonly state: string
  readonly pullRequestNumber: number | null
  readonly completionSummary: string | null
  readonly lifecycleLabels: readonly LifecycleLabelChip[]
}

const BUILD_PHASES = new Set([
  "CREATE_WORKTREE",
  "INSTALL_DEPENDENCIES",
  "IMPLEMENT",
  "ASSESS_CHANGES",
  "PRE_COMMIT",
])

const REVIEW_PHASES = new Set(["REVIEW"])

const CHECKS_PHASES = new Set([
  "GITHUB_STATUS_CHECKS",
  "WATCH_PR_STATUS_CHECKS",
  "INVESTIGATE_PR_STATUS_CHECKS",
])

const MERGE_PHASES = new Set(["MERGE_PR"])

/** PR-path phases that are neither checks nor merge (commit, create PR, …). */
const OTHER_PR_PHASES = new Set([
  "COMMIT",
  "CREATE_PR",
  "RESOLVE_PR_MERGE_CONFLICT",
  "MARK_PR_READY_FOR_REVIEW",
  "DECIDE_PR_MERGE",
  "CLOSE_ISSUE",
  "LOCAL_CLEANUP",
])

type GroupId = "build" | "review" | "checks" | "merge" | "pr_other"

type GroupOutcome = {
  readonly id: GroupId
  readonly chips: readonly LifecycleLabelChip[]
  readonly durationMs: number | null
  readonly hasAny: boolean
  readonly hasSucceeded: boolean
  readonly hasFailed: boolean
}

const isFailedStatus = (status: string): boolean =>
  status === "FAILED" || status === "INTERRUPTED"

const isSucceededStatus = (status: string): boolean =>
  status === "SUCCEEDED" || status === "COMPLETE"

const groupForPhase = (phase: string): GroupId | null => {
  if (BUILD_PHASES.has(phase)) return "build"
  if (REVIEW_PHASES.has(phase)) return "review"
  if (CHECKS_PHASES.has(phase)) return "checks"
  if (MERGE_PHASES.has(phase)) return "merge"
  if (OTHER_PR_PHASES.has(phase)) return "pr_other"
  // Fall back to pipeline lane mapping for unknown phases.
  const lane = lifecycleLaneForPhase(phase)
  if (lane === "build") return "build"
  if (lane === "review") return "review"
  if (lane === "pr") return "pr_other"
  return null
}

const collectGroups = (
  labels: readonly LifecycleLabelChip[],
): Record<GroupId, GroupOutcome> => {
  const buckets: Record<GroupId, LifecycleLabelChip[]> = {
    build: [],
    review: [],
    checks: [],
    merge: [],
    pr_other: [],
  }
  for (const label of labels) {
    const group = groupForPhase(label.phase)
    if (group === null) continue
    buckets[group].push(label)
  }
  const toOutcome = (id: GroupId): GroupOutcome => {
    const chips = buckets[id]
    return {
      id,
      chips,
      durationMs: sumLaneDurationMs(chips),
      hasAny: chips.length > 0,
      hasSucceeded: chips.some((chip) => isSucceededStatus(chip.status)),
      hasFailed: chips.some((chip) => isFailedStatus(chip.status)),
    }
  }
  return {
    build: toOutcome("build"),
    review: toOutcome("review"),
    checks: toOutcome("checks"),
    merge: toOutcome("merge"),
    pr_other: toOutcome("pr_other"),
  }
}

/** Terminal Complete with a no-change summary (and no PR). */
export const isArchiveNoChangeComplete = (
  workItem: Pick<
    ArchiveWorkItemInput,
    "status" | "state" | "pullRequestNumber" | "completionSummary"
  >,
): boolean =>
  (workItem.status === "COMPLETE" || workItem.state === "COMPLETE") &&
  workItem.pullRequestNumber === null &&
  workItem.completionSummary !== null &&
  workItem.completionSummary.trim() !== ""

export const isArchiveAbandoned = (
  workItem: Pick<ArchiveWorkItemInput, "status" | "state">,
): boolean => workItem.status === "ABANDONED" || workItem.state === "ABANDONED"

export const isArchiveComplete = (
  workItem: Pick<ArchiveWorkItemInput, "status" | "state">,
): boolean =>
  workItem.status === "COMPLETE" ||
  workItem.status === "SUCCEEDED" ||
  workItem.state === "COMPLETE"

const doneLeg = (
  id: string,
  label: string,
  lane: ArchiveLegLane,
  durationMs: number | null,
): ArchiveLeg => ({
  id,
  label,
  kind: "done",
  durationMs,
  lane,
})

const skipLeg = (id: string, label: string): ArchiveLeg => ({
  id,
  label,
  kind: "skip",
  durationMs: null,
  lane: null,
})

const failLeg = (
  id: string,
  label: string,
  durationMs: number | null,
): ArchiveLeg => ({
  id,
  label,
  kind: "fail",
  durationMs,
  lane: null,
})

/**
 * Format a leg duration for the archive chip, e.g. "14M" / "1M 30S".
 * Matches the prototype's uppercase mono leg labels.
 */
export function formatArchiveLegDuration(ms: number): string {
  return formatDuration(ms).toUpperCase()
}

/** Text content of a leg chip including mark and optional duration. */
export function archiveLegText(leg: ArchiveLeg): string {
  const mark = leg.kind === "done" ? "✓" : leg.kind === "fail" ? "✕" : "○"
  if (leg.durationMs === null) {
    return `${mark} ${leg.label}`
  }
  return `${mark} ${leg.label} · ${formatArchiveLegDuration(leg.durationMs)}`
}

/** CSS variables for a lane-coloured done leg. */
export function archiveLegLaneStyle(lane: ArchiveLegLane): {
  "--leg-lane": string
  "--leg-on-lane": string
} {
  switch (lane) {
    case "build":
      return {
        "--leg-lane": "var(--lane-build)",
        "--leg-on-lane": "var(--lane-build-ink)",
      }
    case "review":
      return {
        "--leg-lane": "var(--lane-review)",
        "--leg-on-lane": "var(--lane-review-ink)",
      }
    case "pr":
      return {
        "--leg-lane": "var(--lane-pr)",
        "--leg-on-lane": "var(--lane-pr-ink)",
      }
  }
}

/**
 * Plan condensed archive journey legs for a terminal Work Item.
 *
 * - Complete + PR: BUILD / REVIEW / CHECKS / MERGE as done (lane-coloured).
 * - Complete + no change: done build (+ optional review) + "NO PR NEEDED" skip.
 * - Abandoned: done groups, optional ✕ fail at chronological position, then
 *   dashed unreached REVIEW / PR. Retryable failures never appear here.
 */
/**
 * Emit non-failed PR subgroups as done legs (CHECKS then MERGE, or PR for
 * other PR-path phases). Used for abandoned progress that did not fail.
 */
const pushDonePrSubgroups = (
  legs: ArchiveLeg[],
  groups: Record<GroupId, GroupOutcome>,
): void => {
  if (groups.checks.hasAny && !groups.checks.hasFailed) {
    legs.push(doneLeg("checks", "CHECKS", "pr", groups.checks.durationMs))
  }
  if (groups.merge.hasAny && !groups.merge.hasFailed) {
    legs.push(doneLeg("merge", "MERGE", "pr", groups.merge.durationMs))
  } else if (
    !groups.checks.hasAny &&
    !groups.merge.hasAny &&
    groups.pr_other.hasAny &&
    !groups.pr_other.hasFailed
  ) {
    legs.push(
      doneLeg("pr", "PR", "pr", sumLaneDurationMs(groups.pr_other.chips)),
    )
  }
}

export function planArchiveLegs(
  workItem: ArchiveWorkItemInput,
): readonly ArchiveLeg[] {
  const groups = collectGroups(workItem.lifecycleLabels)
  const abandoned = isArchiveAbandoned(workItem)
  const complete = isArchiveComplete(workItem)
  const noChange = isArchiveNoChangeComplete(workItem)
  const hasPr =
    workItem.pullRequestNumber !== null && workItem.pullRequestNumber > 0

  if (complete && noChange) {
    const legs: ArchiveLeg[] = []
    if (groups.build.hasAny || groups.build.hasSucceeded) {
      legs.push(doneLeg("build", "BUILD", "build", groups.build.durationMs))
    } else {
      // Still show BUILD as done when the item completed without step data.
      legs.push(doneLeg("build", "BUILD", "build", null))
    }
    if (groups.review.hasSucceeded) {
      legs.push(doneLeg("review", "REVIEW", "review", groups.review.durationMs))
    }
    legs.push(skipLeg("no_pr", "NO PR NEEDED"))
    return legs
  }

  if (complete && hasPr) {
    // Full PR path: always four lane-coloured legs when the run completed.
    return [
      doneLeg(
        "build",
        "BUILD",
        "build",
        groups.build.hasAny ? groups.build.durationMs : null,
      ),
      doneLeg(
        "review",
        "REVIEW",
        "review",
        groups.review.hasAny ? groups.review.durationMs : null,
      ),
      doneLeg(
        "checks",
        "CHECKS",
        "pr",
        groups.checks.hasAny ? groups.checks.durationMs : null,
      ),
      doneLeg(
        "merge",
        "MERGE",
        "pr",
        groups.merge.hasAny ? groups.merge.durationMs : null,
      ),
    ]
  }

  if (complete) {
    // Complete without PR number and without summary — show done groups only.
    const legs: ArchiveLeg[] = []
    if (groups.build.hasAny) {
      legs.push(doneLeg("build", "BUILD", "build", groups.build.durationMs))
    }
    if (groups.review.hasAny) {
      legs.push(doneLeg("review", "REVIEW", "review", groups.review.durationMs))
    }
    if (groups.checks.hasAny) {
      legs.push(doneLeg("checks", "CHECKS", "pr", groups.checks.durationMs))
    }
    if (groups.merge.hasAny) {
      legs.push(doneLeg("merge", "MERGE", "pr", groups.merge.durationMs))
    }
    if (legs.length === 0) {
      legs.push(doneLeg("build", "BUILD", "build", null))
    }
    return legs
  }

  // Abandoned (and any other terminal archive row).
  const legs: ArchiveLeg[] = []
  let failedEmitted = false

  const pushGroup = (
    group: GroupOutcome,
    doneLabel: string,
    lane: ArchiveLegLane,
  ): "done" | "fail" | "none" => {
    if (!group.hasAny) return "none"
    if (group.hasFailed && abandoned) {
      legs.push(failLeg(group.id, doneLabel, group.durationMs))
      failedEmitted = true
      return "fail"
    }
    if (group.hasSucceeded || group.hasAny) {
      // Abandoned groups are fail-first (handled above). Here: presence with
      // no failure → done. Non-abandoned fail chips stay off the archive.
      if (group.hasFailed && !abandoned) {
        return "none"
      }
      legs.push(doneLeg(group.id, doneLabel, lane, group.durationMs))
      return "done"
    }
    return "none"
  }

  const buildResult = pushGroup(groups.build, "BUILD", "build")
  if (failedEmitted) {
    // Chronological: failed BUILD stops the line; remaining are unreached.
    legs.push(skipLeg("review", "REVIEW"))
    legs.push(skipLeg("pr", "PR"))
    return legs
  }

  const reviewResult = pushGroup(groups.review, "REVIEW", "review")
  if (failedEmitted) {
    legs.push(skipLeg("pr", "PR"))
    return legs
  }

  // PR umbrella for checks / merge / other PR phases on abandoned paths.
  const prChips = [
    ...groups.checks.chips,
    ...groups.merge.chips,
    ...groups.pr_other.chips,
  ]
  const prFailed = prChips.some((chip) => isFailedStatus(chip.status))
  const prSucceeded = prChips.some((chip) => isSucceededStatus(chip.status))
  const prAny = prChips.length > 0

  if (prFailed && abandoned) {
    // Chronological: keep successful earlier PR legs, then ✕ at the failure.
    if (groups.checks.hasFailed) {
      // CHECKS failed first — no prior PR sub-leg to keep.
      legs.push(failLeg("checks", "CHECKS", groups.checks.durationMs))
    } else if (groups.merge.hasFailed) {
      if (groups.checks.hasAny && !groups.checks.hasFailed) {
        legs.push(doneLeg("checks", "CHECKS", "pr", groups.checks.durationMs))
      }
      legs.push(failLeg("merge", "MERGE", groups.merge.durationMs))
    } else {
      // pr_other failed: keep non-failed checks/merge, then ✕ PR with only
      // pr_other duration (do not re-sum CHECKS/MERGE already shown).
      if (groups.checks.hasAny && !groups.checks.hasFailed) {
        legs.push(doneLeg("checks", "CHECKS", "pr", groups.checks.durationMs))
      }
      if (groups.merge.hasAny && !groups.merge.hasFailed) {
        legs.push(doneLeg("merge", "MERGE", "pr", groups.merge.durationMs))
      }
      legs.push(failLeg("pr", "PR", groups.pr_other.durationMs))
    }
    return legs
  }

  if (prSucceeded || prAny) {
    pushDonePrSubgroups(legs, groups)
    // Abandoned journeys that stopped mid-PR still show unreached MERGE when
    // merge never ran (complete+PR always paints the four-leg path).
    if (
      abandoned &&
      !groups.merge.hasAny &&
      !legs.some((leg) => leg.id === "merge" || leg.id === "pr")
    ) {
      legs.push(skipLeg("merge", "MERGE"))
    }
    return legs
  }

  // Unreached tails for abandoned rows.
  if (abandoned) {
    // True "never left the queue" only when nothing is on the line yet.
    if (legs.length === 0) {
      return [
        skipLeg("build", "BUILD"),
        skipLeg("review", "REVIEW"),
        skipLeg("pr", "PR"),
      ]
    }
    if (buildResult === "none") {
      // Partial projection: progress without BUILD chips — keep progress.
      legs.unshift(skipLeg("build", "BUILD"))
    }
    if (reviewResult === "none" && !legs.some((leg) => leg.id === "review")) {
      legs.push(skipLeg("review", "REVIEW"))
    }
    if (
      !legs.some(
        (leg) => leg.id === "pr" || leg.id === "checks" || leg.id === "merge",
      )
    ) {
      legs.push(skipLeg("pr", "PR"))
    }
    return legs
  }

  // Fallback: whatever progress we have.
  if (legs.length === 0) {
    return [
      skipLeg("build", "BUILD"),
      skipLeg("review", "REVIEW"),
      skipLeg("pr", "PR"),
    ]
  }
  return legs
}
