import { useEffect, useState } from "react"

/** Statuses that show a wall-clock-advancing duration in the UI. */
export function isLiveDurationStatus(status: string): boolean {
  return status === "RUNNING"
}

/**
 * Duration to display for a lifecycle label.
 * While running, advances from the last authoritative snapshot using local wall clock.
 */
export function liveDurationMs(
  durationMs: number | null,
  isRunning: boolean,
  snapshotAtMs: number,
  nowMs: number,
): number | null {
  if (durationMs === null) return null
  if (!isRunning || snapshotAtMs <= 0) return durationMs
  return durationMs + Math.max(0, nowMs - snapshotAtMs)
}

/** Formats a duration for step labels, e.g. "3s" or "4m 15s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
}

/**
 * Total wall-clock elapsed time for a Work Item from creation to last state
 * transition (for terminal items: end of the run).
 */
export function totalElapsedMs(
  createdAt: string,
  stateReadyAt: string,
): number {
  return Math.max(
    0,
    new Date(stateReadyAt).getTime() - new Date(createdAt).getTime(),
  )
}

/** Formats job start time as a relative phrase, e.g. "Started 15 min ago". */
export function formatStartedAgo(iso: string, nowMs = Date.now()): string {
  return formatRelativeAgo(iso, nowMs, "Started")
}

/**
 * Relative age phrase for terminal archive rows, e.g. "Merged 38 min ago",
 * "Withdrawn 2 d ago", "Finished yesterday".
 */
export function formatTerminalAgo(
  iso: string,
  verb: "Merged" | "Withdrawn" | "Finished",
  nowMs = Date.now(),
): string {
  return formatRelativeAgo(iso, nowMs, verb)
}

function formatRelativeAgo(iso: string, nowMs: number, verb: string): string {
  const elapsedMs = Math.max(0, nowMs - new Date(iso).getTime())
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) return `${verb} just now`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${verb} ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    if (verb === "Started") {
      return hours === 1 ? `${verb} 1 hour ago` : `${verb} ${hours} hours ago`
    }
    // Archive prototype prefers compact "2 h ago".
    return hours === 1 ? `${verb} 1 h ago` : `${verb} ${hours} h ago`
  }
  const days = Math.floor(hours / 24)
  if (verb !== "Started") {
    return days === 1 ? `${verb} yesterday` : `${verb} ${days} d ago`
  }
  return days === 1 ? `${verb} 1 day ago` : `${verb} ${days} days ago`
}

/** Short session id for archive meta, e.g. "9a2c…55e8". */
export function formatSessionShort(sessionId: string): string {
  if (sessionId.length <= 10) return sessionId
  return `${sessionId.slice(0, 4)}…${sessionId.slice(-4)}`
}

/** Worktree leaf name for archive meta, e.g. "worktree3". */
export function worktreeLeafName(worktreePath: string): string {
  const normalized = worktreePath.replace(/[/\\]+$/, "")
  const parts = normalized.split(/[/\\]/)
  const leaf = parts[parts.length - 1]
  return leaf !== undefined && leaf !== "" ? leaf : worktreePath
}

/** Local wall-clock tick for animating live durations and relative ages. */
export function useNowMs(enabled: boolean, intervalMs = 1000): number {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNowMs(Date.now())
    const id = setInterval(() => {
      setNowMs(Date.now())
    }, intervalMs)
    return () => clearInterval(id)
  }, [enabled, intervalMs])
  return nowMs
}
