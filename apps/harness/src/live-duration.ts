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

/** Formats job start time as a relative phrase, e.g. "Started 15 min ago". */
export function formatStartedAgo(iso: string, nowMs = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - new Date(iso).getTime())
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) return "Started just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Started ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return hours === 1 ? "Started 1 hour ago" : `Started ${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? "Started 1 day ago" : `Started ${days} days ago`
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
