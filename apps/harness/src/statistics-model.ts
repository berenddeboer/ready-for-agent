import {
  type LifecyclePipelineLaneId,
  lifecycleLaneForState,
} from "./pipeline-lanes.js"
import type { TimingWorkItem } from "./statistics-query.js"

export const timingLanes = ["build", "review", "pr"] as const
export type TimingLane = LifecyclePipelineLaneId
export const timingLaneLabels = { build: "Build", review: "Review", pr: "PR" }
export const timingLaneColors = {
  build: "var(--lane-build)",
  review: "var(--lane-review)",
  pr: "var(--lane-pr)",
}
const stepLabels: Record<string, string> = {
  create_worktree: "Create worktree",
  install_dependencies: "Install dependencies",
  implement: "Implement",
  assess_changes: "Assess changes",
  pre_commit: "Pre-Commit",
  review: "Review",
  commit: "Commit",
  create_pr: "Create PR",
  watch_pr_status_checks: "Watch PR status checks",
  investigate_pr_status_checks: "Investigate PR status checks",
  resolve_pr_merge_conflict: "Resolve PR merge conflict",
  mark_pr_ready_for_review: "Mark PR ready for review",
  decide_pr_merge: "Decide PR merge",
  merge_pr: "Merge PR",
  close_issue: "Close issue",
  local_cleanup: "Local cleanup",
}
export const stepLabel = (step: string) =>
  stepLabels[step] ?? step.replaceAll("_", " ")
export const sum = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0)
export function percentile(
  values: readonly number[],
  fraction: number,
): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * fraction
  const low = sorted[Math.floor(position)] ?? 0
  return low + ((sorted[Math.ceil(position)] ?? low) - low) * (position % 1)
}
export function describeTimes(values: readonly number[]) {
  return {
    count: values.length,
    total: sum(values),
    average: values.length ? sum(values) / values.length : null,
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
  }
}
export function formatTime(ms: number | null): string {
  if (ms === null) return "—"
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} sec`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`
  return `${(ms / 3_600_000).toFixed(1)} h`
}
const validDuration = (
  start: number | null,
  end: number | null,
): number | null =>
  start !== null &&
  end !== null &&
  Number.isFinite(start) &&
  Number.isFinite(end) &&
  end >= start
    ? end - start
    : null

type Attempt = TimingWorkItem["attempts"][number]
export function measureAttempts(attempts: readonly Attempt[]) {
  let execution = 0
  let timed = 0
  let missing = 0
  let repeats = 0
  let repeatMs = 0
  let queueMs = 0
  let sessionWaitMs = 0
  const seen = new Map<string, number>()
  // The API has a stable queued_at / rowid ordering. Preserve it on ties.
  const details = [...attempts]
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .map((attempt) => {
      const duration = validDuration(attempt.startedAt, attempt.finishedAt)
      const neverRan =
        attempt.startedAt === null &&
        (attempt.status === "cancelled" || attempt.status === "postponed")
      if (!neverRan) {
        if (duration === null) missing++
        else {
          execution += duration
          timed++
        }
      }
      // Watch is observation/polling. Postponed attempts are throttle yields,
      // not retries; neither they nor cancellations consume a repeat ordinal.
      const eligible =
        attempt.startedAt !== null &&
        attempt.status !== "postponed" &&
        attempt.status !== "cancelled" &&
        attempt.step !== "watch_pr_status_checks"
      const repeat = eligible && (seen.get(attempt.step) ?? 0) > 0
      if (eligible) seen.set(attempt.step, (seen.get(attempt.step) ?? 0) + 1)
      if (repeat) {
        repeats++
        repeatMs += duration ?? 0
      }
      const queue = validDuration(
        attempt.queuedAt,
        attempt.startedAt ?? attempt.finishedAt,
      )
      queueMs += queue ?? 0
      const wait =
        duration === null
          ? 0
          : Math.min(duration, Math.max(0, attempt.sessionWaitMs))
      sessionWaitMs += wait
      return { ...attempt, duration, repeat, queue, sessionWait: wait }
    })
  return {
    executionMs: timed > 0 && missing === 0 ? execution : null,
    recordedMs: execution,
    timed,
    missing,
    repeats,
    repeatMs,
    queueMs,
    sessionWaitMs,
    details,
  }
}

export function projectTimingTask(item: TimingWorkItem) {
  const measurement = measureAttempts(item.attempts)
  const lane = (name: TimingLane) =>
    measureAttempts(
      item.attempts.filter(
        (a) => lifecycleLaneForState(a.step.toUpperCase()) === name,
      ),
    )
  return {
    ...item,
    ...measurement,
    label: item.displayId ?? item.id,
    title:
      item.title ??
      (item.origin === "ci_repair" ? "CI repair" : "Historical Work Item"),
    elapsedMs: validDuration(item.createdAt, item.completedAt),
    lanes: { build: lane("build"), review: lane("review"), pr: lane("pr") },
  }
}
export type TimingTask = ReturnType<typeof projectTimingTask>
export function laneStatistics(tasks: readonly TimingTask[], lane: TimingLane) {
  const observations = tasks.map((task) => task.lanes[lane])
  return {
    ...describeTimes(
      observations.flatMap((m) =>
        m.executionMs === null ? [] : [m.executionMs],
      ),
    ),
    repeatMs: sum(observations.map((m) => m.repeatMs)),
    affected: observations.filter((m) => m.repeats > 0).length,
    observed: observations.filter((m) => m.timed > 0 || m.missing > 0).length,
  }
}
export function stepStatistics(tasks: readonly TimingTask[]) {
  const names = new Set(
    tasks.flatMap((task) => task.attempts.map((a) => a.step)),
  )
  return [...names]
    .map((step) => {
      const measurements = tasks.map((task) =>
        measureAttempts(task.attempts.filter((a) => a.step === step)),
      )
      const attempts = measurements.flatMap((m) => m.details)
      return {
        step,
        lane: lifecycleLaneForState(step.toUpperCase()),
        perTask: describeTimes(
          measurements.flatMap((m) =>
            m.executionMs === null ? [] : [m.executionMs],
          ),
        ),
        perAttempt: describeTimes(
          attempts.flatMap((a) => (a.duration === null ? [] : [a.duration])),
        ),
        repeats: sum(measurements.map((m) => m.repeats)),
        repeatMs: sum(measurements.map((m) => m.repeatMs)),
        missing: sum(measurements.map((m) => m.missing)),
        failures: attempts.filter((a) => a.status === "failed").length,
        affected: measurements.filter((m) => m.repeats > 0).length,
      }
    })
    .sort(
      (a, b) =>
        b.perAttempt.total - a.perAttempt.total || a.step.localeCompare(b.step),
    )
}
