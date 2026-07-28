import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { Clock, Duration, Effect } from "effect"

/**
 * Probe whether a pid still exists. `EPERM` means the process is present but
 * unsignallable from this uid — treat as alive so wait/escalate still runs.
 */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined
    return code === "EPERM"
  }
}

/** Linux `/proc/<pid>/stat` starttime (field 22) for pid-reuse guards. */
const readStarttime = (pid: number): string | undefined => {
  if (process.platform !== "linux") return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    // Fields after comm: state, ppid, ... starttime is 22nd overall → index 19.
    return afterComm[19]
  } catch {
    return undefined
  }
}

type TrackedPid = {
  readonly pid: number
  readonly starttime: string | undefined
}

const trackPid = (pid: number): TrackedPid => ({
  pid,
  starttime: readStarttime(pid),
})

/**
 * True if the pid still looks like the same process we snapshotted.
 *
 * - No starttime (non-Linux): fall back to liveness only.
 * - Starttime known but re-read fails: not same (avoid kill-on-recycle after a
 *   transient /proc glitch when we *did* capture identity).
 * - Prefer kill only when identity was never available at track time.
 */
const isSameProcess = (tracked: TrackedPid): boolean => {
  if (!isAlive(tracked.pid)) return false
  if (tracked.starttime === undefined) return true
  const current = readStarttime(tracked.pid)
  if (current === undefined) return false
  return current === tracked.starttime
}

const listDirectChildren = (pid: number): number[] => {
  if (process.platform === "linux") {
    const children: number[] = []
    try {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
          // `/proc/<pid>/stat`: after comm (possibly with spaces), fields are
          // state, ppid, pgrp, session, ...
          const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
          if (Number(afterComm[1]) === pid) {
            children.push(Number(entry))
          }
        } catch {
          // Process exited mid-scan.
        }
      }
    } catch {
      // /proc unavailable.
    }
    return children
  }

  if (process.platform === "win32") {
    return []
  }

  // macOS and other POSIX: pgrep -P lists direct children.
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

/**
 * Depth-first list of every process currently descended from `rootPid`.
 *
 * Snapshot before signalling the root so children that reparent after the
 * leader dies remain killable.
 */
const listDescendantPids = (rootPid: number): number[] => {
  const result: number[] = []
  const stack = [rootPid]
  const seen = new Set<number>([rootPid])
  while (stack.length > 0) {
    const pid = stack.pop()
    if (pid === undefined) break
    for (const child of listDirectChildren(pid)) {
      if (!seen.has(child)) {
        seen.add(child)
        result.push(child)
        stack.push(child)
      }
    }
  }
  return result
}

const signalPid = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(pid, signal)
  } catch {
    // Already dead or not permitted.
  }
}

/** Negative-pid group signal when the CLI was started as a process group leader. */
const signalProcessGroup = (pgid: number, signal: NodeJS.Signals): void => {
  if (process.platform === "win32") return
  try {
    process.kill(-pgid, signal)
  } catch {
    // Not a group leader, group already gone, or ESRCH.
  }
}

const signalTree = (
  root: TrackedPid,
  descendants: ReadonlyArray<TrackedPid>,
  signal: NodeJS.Signals,
): void => {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(root.pid), "/T", "/F"], {
        stdio: "ignore",
      })
    } catch {
      // Process already gone.
    }
    return
  }

  // Group first only while the root still looks like the process we started
  // (avoids signalling a recycled pid's process group).
  if (isSameProcess(root)) {
    signalProcessGroup(root.pid, signal)
    signalPid(root.pid, signal)
  }
  for (const tracked of descendants) {
    if (isSameProcess(tracked)) {
      signalPid(tracked.pid, signal)
    }
  }
}

/**
 * Whether any of the *original* snapshotted tree is still alive.
 *
 * Checks only the root and the initial descendant snapshot (starttime-gated).
 * Does not re-walk PPID under the root — that would follow a recycled root
 * pid. Late-spawned children are reaped in escalate when the root is still
 * ours.
 */
const anyAlive = (
  root: TrackedPid,
  descendants: ReadonlyArray<TrackedPid>,
): boolean => {
  if (isSameProcess(root)) {
    return true
  }
  if (descendants.some(isSameProcess)) {
    return true
  }
  return false
}

export type KillProcessTreeOptions = {
  readonly forceKillAfter?: Duration.Input
}

/**
 * Kill a harness-spawned CLI and everything it started.
 *
 * 1. Snapshot descendants via PPID (catches `setsid` grandchildren still in the tree).
 * 2. SIGTERM the process group and every known pid.
 * 3. Wait up to `forceKillAfter`, then always SIGKILL (via `Effect.ensuring`) so
 *    interruption/timeout cannot leave the tree SIGTERM-only.
 */
export const killProcessTree = (
  rootPid: number,
  options: KillProcessTreeOptions = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!Number.isFinite(rootPid) || rootPid <= 0) {
      return
    }

    if (process.platform === "win32") {
      signalTree(trackPid(rootPid), [], "SIGKILL")
      return
    }

    const forceKillAfter = options.forceKillAfter ?? Duration.seconds(2)
    const root = trackPid(rootPid)
    const descendants = listDescendantPids(rootPid).map(trackPid)

    // Ensuring body must stay short (uninterruptible). Re-scan only when the
    // original root is still ours; always SIGKILL the starttime-checked snapshot
    // so setsid orphans reaped from the initial walk still die.
    const escalate = Effect.sync(() => {
      const byPid = new Map<number, TrackedPid>()
      for (const tracked of descendants) {
        byPid.set(tracked.pid, tracked)
      }
      if (isSameProcess(root)) {
        for (const tracked of listDescendantPids(rootPid).map(trackPid)) {
          byPid.set(tracked.pid, tracked)
        }
      }
      signalTree(root, [...byPid.values()], "SIGKILL")
    })

    yield* Effect.gen(function* () {
      signalTree(root, descendants, "SIGTERM")

      const forceMs = Duration.toMillis(forceKillAfter)
      const started = yield* Clock.currentTimeMillis
      while ((yield* Clock.currentTimeMillis) - started < forceMs) {
        if (!anyAlive(root, descendants)) {
          return
        }
        yield* Effect.sleep(Duration.millis(25))
      }
    }).pipe(Effect.ensuring(escalate))
  })
