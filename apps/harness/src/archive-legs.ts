/**
 * Archive journey-leg planning for the Completed page
 * (`docs/harness-design-system.md` §4.5 / §5.2, wayfinder #698 prototype).
 *
 * The archive is terminal Complete / Abandoned only. Legs are a condensed
 * BUILD → REVIEW → PR|MR (or NO PR|MR NEEDED) view — not the full fine-grained
 * lifecycle chip list used on the board.
 *
 * The entire forge change-request path (status checks, create, merge, …) is
 * one PR-lane leg labelled PR (GitHub) or MR (GitLab). Legs with underlying
 * step chips are expandable (same expand/collapse pattern as Kanban earlier-
 * lane summaries) so operators can open the fine-grained lifecycle list.
 */

import { forgeChangeRequestShort } from "./forge-change-request.js"
import {
  type LifecycleLabelChip,
  lifecycleLaneForPhase,
  sumLaneDurationMs,
} from "./pipeline-lanes.js"

type ArchiveLegKind = "done" | "skip" | "fail"

/** CSS custom props for lane-coloured done legs. */
export type ArchiveLegLane = "build" | "review" | "pr"

export type ArchiveLeg = {
  readonly id: string
  readonly label: string
  readonly kind: ArchiveLegKind
  readonly durationMs: number | null
  /** Lane colour for done legs; fail always uses Attention. */
  readonly lane: ArchiveLegLane | null
  /** Optional hover title (e.g. forge noun for the PR-lane leg). */
  readonly title: string | null
  /**
   * Fine-grained lifecycle chips under this leg. Non-empty ⇒ expandable in
   * the Completed card footer (ephemeral UI expand, like Kanban).
   */
  readonly chips: readonly LifecycleLabelChip[]
}

export type ArchiveWorkItemInput = {
  readonly status: string
  readonly state: string
  readonly pullRequestNumber: number | null
  readonly completionSummary: string | null
  readonly lifecycleLabels: readonly LifecycleLabelChip[]
  /** Repository forge — drives PR vs MR leg labels. Defaults to GitHub. */
  readonly forge?: string | null
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

const isArchiveComplete = (
  workItem: Pick<ArchiveWorkItemInput, "status" | "state">,
): boolean =>
  workItem.status === "COMPLETE" ||
  workItem.status === "SUCCEEDED" ||
  workItem.state === "COMPLETE"

const changeLegTitle = (short: string): string =>
  short === "MR"
    ? "Merge request path — create, checks, and merge time on GitLab"
    : "Pull request path — create, checks, and merge time on GitHub"

/** Sum nullable subgroup durations; null when every part is null/absent. */
const sumNullableMs = (
  ...parts: readonly (number | null | undefined)[]
): number | null => {
  let total = 0
  let any = false
  for (const part of parts) {
    if (part === null || part === undefined) continue
    total += part
    any = true
  }
  return any ? total : null
}

const doneLeg = (
  id: string,
  label: string,
  lane: ArchiveLegLane,
  durationMs: number | null,
  chips: readonly LifecycleLabelChip[] = [],
  title: string | null = null,
): ArchiveLeg => ({
  id,
  label,
  kind: "done",
  durationMs,
  lane,
  title,
  chips,
})

const skipLeg = (
  id: string,
  label: string,
  title: string | null = null,
): ArchiveLeg => ({
  id,
  label,
  kind: "skip",
  durationMs: null,
  lane: null,
  title,
  chips: [],
})

const failLeg = (
  id: string,
  label: string,
  durationMs: number | null,
  chips: readonly LifecycleLabelChip[] = [],
  title: string | null = null,
): ArchiveLeg => ({
  id,
  label,
  kind: "fail",
  durationMs,
  lane: null,
  title,
  chips,
})

/**
 * Format a leg duration for the archive chip: compact lowercase, no spaces
 * between units — "7m27s", "14m", "45s", "1h5m".
 */
export function formatArchiveLegDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h${remainingMinutes}m`
}

/**
 * Text content of a leg chip. Done legs omit the ✓ (lane colour is enough);
 * fail / skip keep ✕ / ○ so exceptions stay scannable.
 */
export function archiveLegText(leg: ArchiveLeg): string {
  if (leg.kind === "done") {
    if (leg.durationMs === null) return leg.label
    return `${leg.label} · ${formatArchiveLegDuration(leg.durationMs)}`
  }
  const mark = leg.kind === "fail" ? "✕" : "○"
  if (leg.durationMs === null) {
    return `${mark} ${leg.label}`
  }
  return `${mark} ${leg.label} · ${formatArchiveLegDuration(leg.durationMs)}`
}

/**
 * CSS variables for a lane-coloured done leg.
 * Must match `lifecycleLaneCssVars` / `ui.legLane` (`--leg-lane`, `--leg-on`).
 */
export function archiveLegLaneStyle(lane: ArchiveLegLane): {
  "--leg-lane": string
  "--leg-on": string
} {
  switch (lane) {
    case "build":
      return {
        "--leg-lane": "var(--lane-build)",
        "--leg-on": "var(--lane-build-ink)",
      }
    case "review":
      return {
        "--leg-lane": "var(--lane-review)",
        "--leg-on": "var(--lane-review-ink)",
      }
    case "pr":
      return {
        "--leg-lane": "var(--lane-pr)",
        "--leg-on": "var(--lane-pr-ink)",
      }
  }
}

/**
 * Plan condensed archive journey legs for a terminal Work Item.
 *
 * - Complete + PR: BUILD / REVIEW / PR|MR as done (lane-coloured).
 * - Complete + no change: done build (+ optional review) + "NO PR|MR NEEDED".
 * - Abandoned: done groups, optional ✕ fail at chronological position, then
 *   dashed unreached REVIEW / PR|MR. Retryable failures never appear here.
 *
 * The PR lane is a single forge-labelled chip (checks + merge + other PR
 * phases summed). The black badge opens the change request on the forge.
 */
export function planArchiveLegs(
  workItem: ArchiveWorkItemInput,
): readonly ArchiveLeg[] {
  const groups = collectGroups(workItem.lifecycleLabels)
  const abandoned = isArchiveAbandoned(workItem)
  const complete = isArchiveComplete(workItem)
  const noChange = isArchiveNoChangeComplete(workItem)
  const hasPr =
    workItem.pullRequestNumber !== null && workItem.pullRequestNumber > 0
  const changeShort = forgeChangeRequestShort(workItem.forge)
  const changeTitle = changeLegTitle(changeShort)
  const noChangeNeededLabel = `NO ${changeShort} NEEDED`

  const prChips = [
    ...groups.checks.chips,
    ...groups.merge.chips,
    ...groups.pr_other.chips,
  ]
  const prAny = prChips.length > 0
  const prFailed = prChips.some((chip) => isFailedStatus(chip.status))
  const prSucceeded = prChips.some((chip) => isSucceededStatus(chip.status))
  const prDurationMs = sumLaneDurationMs(prChips)
  /** Duration of only the failed PR-path chips (for ✕ legs). */
  const prFailDurationMs = sumLaneDurationMs(
    prChips.filter((chip) => isFailedStatus(chip.status)),
  )
  const prPathDurationMs = sumNullableMs(
    groups.checks.hasAny ? groups.checks.durationMs : null,
    groups.merge.hasAny ? groups.merge.durationMs : null,
    groups.pr_other.hasAny ? groups.pr_other.durationMs : null,
  )

  const changeDone = (durationMs: number | null): ArchiveLeg =>
    doneLeg("pr", changeShort, "pr", durationMs, prChips, changeTitle)
  const changeSkip = (): ArchiveLeg => skipLeg("pr", changeShort, changeTitle)
  const changeFail = (durationMs: number | null): ArchiveLeg =>
    failLeg("pr", changeShort, durationMs, prChips, changeTitle)

  if (complete && noChange) {
    const legs: ArchiveLeg[] = []
    if (groups.build.hasAny || groups.build.hasSucceeded) {
      legs.push(
        doneLeg(
          "build",
          "BUILD",
          "build",
          groups.build.durationMs,
          groups.build.chips,
        ),
      )
    } else {
      // Still show BUILD as done when the item completed without step data.
      legs.push(doneLeg("build", "BUILD", "build", null))
    }
    if (groups.review.hasSucceeded) {
      legs.push(
        doneLeg(
          "review",
          "REVIEW",
          "review",
          groups.review.durationMs,
          groups.review.chips,
        ),
      )
    }
    legs.push(skipLeg("no_pr", noChangeNeededLabel))
    return legs
  }

  if (complete && hasPr) {
    // Full PR path: three lane-coloured legs (PR lane is one forge chip).
    return [
      doneLeg(
        "build",
        "BUILD",
        "build",
        groups.build.hasAny ? groups.build.durationMs : null,
        groups.build.chips,
      ),
      doneLeg(
        "review",
        "REVIEW",
        "review",
        groups.review.hasAny ? groups.review.durationMs : null,
        groups.review.chips,
      ),
      changeDone(prAny ? prDurationMs : null),
    ]
  }

  if (complete) {
    // Complete without PR number and without summary — show done groups only.
    const legs: ArchiveLeg[] = []
    if (groups.build.hasAny) {
      legs.push(
        doneLeg(
          "build",
          "BUILD",
          "build",
          groups.build.durationMs,
          groups.build.chips,
        ),
      )
    }
    if (groups.review.hasAny) {
      legs.push(
        doneLeg(
          "review",
          "REVIEW",
          "review",
          groups.review.durationMs,
          groups.review.chips,
        ),
      )
    }
    if (prAny) {
      legs.push(changeDone(prDurationMs))
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
      legs.push(failLeg(group.id, doneLabel, group.durationMs, group.chips))
      failedEmitted = true
      return "fail"
    }
    if (group.hasSucceeded || group.hasAny) {
      // Abandoned groups are fail-first (handled above). Here: presence with
      // no failure → done. Non-abandoned fail chips stay off the archive.
      if (group.hasFailed && !abandoned) {
        return "none"
      }
      legs.push(
        doneLeg(group.id, doneLabel, lane, group.durationMs, group.chips),
      )
      return "done"
    }
    return "none"
  }

  const buildResult = pushGroup(groups.build, "BUILD", "build")
  if (failedEmitted) {
    // Chronological: failed BUILD stops the line; remaining are unreached.
    legs.push(skipLeg("review", "REVIEW"))
    legs.push(changeSkip())
    return legs
  }

  const reviewResult = pushGroup(groups.review, "REVIEW", "review")
  if (failedEmitted) {
    legs.push(changeSkip())
    return legs
  }

  if (prFailed && abandoned) {
    // Single ✕ PR|MR for any failure on the change-request path.
    legs.push(
      changeFail(
        prFailDurationMs !== null ? prFailDurationMs : prPathDurationMs,
      ),
    )
    return legs
  }

  if (prSucceeded || prAny) {
    legs.push(changeDone(prDurationMs))
    return legs
  }

  // Unreached tails for abandoned rows.
  if (abandoned) {
    // True "never left the queue" only when nothing is on the line yet.
    if (legs.length === 0) {
      return [
        skipLeg("build", "BUILD"),
        skipLeg("review", "REVIEW"),
        changeSkip(),
      ]
    }
    if (buildResult === "none") {
      // Partial projection: progress without BUILD chips — keep progress.
      legs.unshift(skipLeg("build", "BUILD"))
    }
    if (reviewResult === "none" && !legs.some((leg) => leg.id === "review")) {
      legs.push(skipLeg("review", "REVIEW"))
    }
    if (!legs.some((leg) => leg.id === "pr")) {
      legs.push(changeSkip())
    }
    return legs
  }

  // Fallback: whatever progress we have.
  if (legs.length === 0) {
    return [
      skipLeg("build", "BUILD"),
      skipLeg("review", "REVIEW"),
      changeSkip(),
    ]
  }
  return legs
}
