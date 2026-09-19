import { randomUUID } from "node:crypto"
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Option,
  Ref,
  Schema,
} from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess } from "effect/unstable/process"
import type { CommandOptions } from "effect/unstable/process/ChildProcess"
import type {
  ChildProcessHandle,
  ChildProcessSpawner,
} from "effect/unstable/process/ChildProcessSpawner"
import { isProcessAlive, killProcessTree } from "./kill-process-tree.js"

/** Graceful terminate then force-kill bound for an owned invocation. */
const DEFAULT_INVOCATION_FORCE_KILL_AFTER = Duration.seconds(2)

const CGROUP_ENTER_SCRIPT =
  'printf \'%s\\n\' "$$" > "$RFA_INVOCATION_CGROUP/cgroup.procs" && exec "$0" "$@"'

const INVOCATION_CGROUP_ENV = "RFA_INVOCATION_CGROUP"
const INVOCATION_ID_ENV = "RFA_INVOCATION_ID"

const HARNESS_PID_PROTECT = (): ReadonlySet<number> =>
  new Set(
    [1, process.pid, process.ppid].filter(
      (pid) => Number.isFinite(pid) && pid > 0,
    ),
  )

export class InvocationContainmentError extends Schema.TaggedErrorClass<InvocationContainmentError>()(
  "InvocationContainmentError",
  {
    message: Schema.String,
    platform: Schema.String,
  },
) {}

export class InvocationCleanupError extends Schema.TaggedErrorClass<InvocationCleanupError>()(
  "InvocationCleanupError",
  {
    message: Schema.String,
    invocationId: Schema.String,
    leftoverPids: Schema.Array(Schema.Finite),
  },
) {}

export const InvocationCleanupSlot = Context.Reference<
  Ref.Ref<InvocationCleanupError | undefined> | undefined
>("@ready-for-agent/agent-backend/InvocationCleanupSlot", {
  defaultValue: () => undefined,
})

export const getInvocationCleanupFailure: Effect.Effect<
  InvocationCleanupError | undefined
> = Effect.gen(function* () {
  const slot = yield* InvocationCleanupSlot
  if (slot === undefined) {
    return undefined
  }
  return yield* Ref.get(slot)
})

export const recordInvocationCleanupFailure = (
  error: InvocationCleanupError | undefined,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const slot = yield* InvocationCleanupSlot
    if (slot === undefined) {
      return
    }
    yield* Ref.set(slot, error)
  })

export type InvocationContainment =
  | {
      readonly kind: "cgroup"
      readonly cgroupPath: string
    }
  | {
      readonly kind: "best_effort"
      readonly reason: string
    }

export type InvocationBoundary = {
  readonly id: string
  readonly containment: InvocationContainment
  bindRootPid: (pid: number) => void
  readonly getRootPid: () => number | undefined
}

type InvocationRegistryRecord = {
  readonly id: string
  readonly harnessPid: number
  readonly harnessStarttime?: string
  readonly cgroupPath?: string
  readonly createdAt: number
}

const readStarttime = (pid: number): string | undefined => {
  if (process.platform !== "linux") return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return afterComm[19]
  } catch {
    return undefined
  }
}

const readPgrp = (pid: number): number | undefined => {
  if (process.platform === "win32") return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const pgrp = Number(afterComm[2])
    return Number.isFinite(pgrp) && pgrp > 0 ? pgrp : undefined
  } catch {
    return undefined
  }
}

const readCmdline = (pid: number): string => {
  if (process.platform !== "linux") return ""
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .replace(/\0/g, " ")
      .trim()
  } catch {
    return ""
  }
}

const runtimeDir = (): string => {
  const xdg = process.env["XDG_RUNTIME_DIR"]
  if (xdg !== undefined && xdg.trim() !== "") {
    return xdg
  }
  const uid = process.getuid?.()
  if (uid !== undefined) {
    return `/run/user/${uid}`
  }
  return tmpdir()
}

const invocationRegistryDirectory = (): string =>
  join(runtimeDir(), "ready-for-agent", "invocations")

const registryPathFor = (id: string): string =>
  join(invocationRegistryDirectory(), `${id}.json`)

const writeRegistry = (record: InvocationRegistryRecord): void => {
  try {
    const dir = invocationRegistryDirectory()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(registryPathFor(record.id), `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    })
  } catch {
    // Ownership still holds for this process; restart recovery may miss it.
  }
}

const removeRegistry = (id: string): void => {
  try {
    unlinkSync(registryPathFor(id))
  } catch {
    // Already gone.
  }
}

const readSelfCgroupRel = (): string | undefined => {
  try {
    const text = readFileSync("/proc/self/cgroup", "utf8")
    const line = text.split("\n").find((entry) => entry.startsWith("0::"))
    return line?.slice(3).trim()
  } catch {
    return undefined
  }
}

const tryMkdir = (dir: string): boolean => {
  try {
    mkdirSync(dir, { mode: 0o755 })
    return true
  } catch {
    return false
  }
}

const parentAllowsChildCgroup = (parent: string): boolean => {
  try {
    accessSync(parent, constants.W_OK)
  } catch {
    return false
  }
  const probe = join(parent, `.rfa-probe-${process.pid}-${Date.now()}`)
  if (!tryMkdir(probe)) {
    return false
  }
  try {
    rmdirSync(probe)
  } catch {
    // Probe dir remains; not fatal for later invocation mkdir.
  }
  return true
}

const linuxCgroupRoot = "/sys/fs/cgroup"

const linuxCgroupPath = (rel: string): string => {
  const trimmed = rel.trim()
  if (trimmed === "" || trimmed === "/") {
    return linuxCgroupRoot
  }
  return join(
    linuxCgroupRoot,
    trimmed.startsWith("/") ? trimmed.slice(1) : trimmed,
  )
}

/**
 * Writable cgroup v2 parents where this process can create a sibling/child
 * invocation cgroup without moving the Harness itself.
 */
export const linuxCgroupParentCandidates = (): readonly string[] => {
  const uid = process.getuid?.() ?? 1000
  const candidates: string[] = [
    `${linuxCgroupRoot}/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`,
    `${linuxCgroupRoot}/user.slice/user-${uid}.slice/user@${uid}.service`,
  ]
  const selfRel = readSelfCgroupRel()
  if (selfRel !== undefined && selfRel.length > 0) {
    let dir = linuxCgroupPath(selfRel)
    while (dir.startsWith(linuxCgroupRoot) && dir !== linuxCgroupRoot) {
      candidates.push(dir)
      dir = dirname(dir)
    }
    candidates.push(linuxCgroupRoot)
  }
  return [...new Set(candidates)]
}

export const findWritableLinuxCgroupParent = (): string | undefined => {
  for (const parent of linuxCgroupParentCandidates()) {
    if (parentAllowsChildCgroup(parent)) {
      return parent
    }
  }
  return undefined
}

const createLinuxCgroup = (
  id: string,
): { readonly cgroupPath: string } | undefined => {
  const parent = findWritableLinuxCgroupParent()
  if (parent === undefined) {
    return undefined
  }
  const cgroupPath = join(parent, `rfa-inv-${id}`)
  if (!tryMkdir(cgroupPath)) {
    return undefined
  }
  return { cgroupPath }
}

const linuxContainmentUnavailableMessage = (platform: string): string =>
  `Cannot establish an invocation cgroup on ${platform}. Agent Turns and native repository commands require a Linux cgroup v2 parent this process can mkdir into (typically a systemd user session under app.slice, or a delegated container cgroup) so timeout and Interrupt cannot leave reparented descendants running.`

const bestEffortReason = (platform: string): string =>
  `${platform} has no kernel cgroup equivalent in this Harness; ownership is a POSIX process group plus a PPID scan at cleanup, which cannot guarantee that a descendant which setsid/double-forks and is reparented before cleanup begins will be terminated.`

const listCgroupPids = (cgroupPath: string): number[] => {
  try {
    return readFileSync(join(cgroupPath, "cgroup.procs"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isFinite(pid) && pid > 0)
  } catch {
    return []
  }
}

const signalPid = (pid: number, signal: NodeJS.Signals): void => {
  if (HARNESS_PID_PROTECT().has(pid)) {
    return
  }
  try {
    process.kill(pid, signal)
  } catch {
    // Already dead or not permitted.
  }
}

const signalProcessGroup = (pgid: number, signal: NodeJS.Signals): void => {
  if (process.platform === "win32") return
  if (HARNESS_PID_PROTECT().has(pgid)) {
    return
  }
  try {
    process.kill(-pgid, signal)
  } catch {
    // Not a group leader, group already gone, or ESRCH.
  }
}

const writeCgroupFile = (cgroupPath: string, name: string, value: string) => {
  try {
    writeFileSync(join(cgroupPath, name), value)
  } catch {
    // File missing or not writable on this cgroup.
  }
}

const leftoverDiagnostics = (pids: ReadonlyArray<number>): string => {
  const parts = pids.map((pid) => {
    const cmd = readCmdline(pid)
    return cmd.length > 0 ? `${pid} (${cmd})` : String(pid)
  })
  return parts.join(", ")
}

const cgroupDirRemoved = (cgroupPath: string): boolean => {
  try {
    rmdirSync(cgroupPath)
    return true
  } catch {
    return !existsSync(cgroupPath)
  }
}

const createBoundary = (): InvocationBoundary | InvocationContainmentError => {
  const id = randomUUID()
  const harnessPid = process.pid
  const harnessStarttime = readStarttime(harnessPid)
  let rootPid: number | undefined

  if (process.platform === "linux") {
    const created = createLinuxCgroup(id)
    if (created === undefined) {
      return new InvocationContainmentError({
        message: linuxContainmentUnavailableMessage(process.platform),
        platform: process.platform,
      })
    }
    writeRegistry({
      id,
      harnessPid,
      ...(harnessStarttime !== undefined ? { harnessStarttime } : {}),
      cgroupPath: created.cgroupPath,
      createdAt: Date.now(),
    })
    return {
      id,
      containment: { kind: "cgroup", cgroupPath: created.cgroupPath },
      bindRootPid: (pid) => {
        rootPid = pid
      },
      getRootPid: () => rootPid,
    }
  }

  writeRegistry({
    id,
    harnessPid,
    ...(harnessStarttime !== undefined ? { harnessStarttime } : {}),
    createdAt: Date.now(),
  })
  return {
    id,
    containment: {
      kind: "best_effort",
      reason: bestEffortReason(process.platform),
    },
    bindRootPid: (pid) => {
      rootPid = pid
    },
    getRootPid: () => rootPid,
  }
}

const collectOwnedPids = (
  cgroupPath: string,
  rootPid: number | undefined,
): number[] => {
  const pids = listCgroupPids(cgroupPath)
  if (
    rootPid !== undefined &&
    rootPid > 0 &&
    !HARNESS_PID_PROTECT().has(rootPid) &&
    !pids.includes(rootPid) &&
    isProcessAlive(rootPid)
  ) {
    pids.push(rootPid)
  }
  return pids
}

const signalOwnedMembers = (
  cgroupPath: string,
  rootPid: number | undefined,
  signal: NodeJS.Signals,
): void => {
  const pids = collectOwnedPids(cgroupPath, rootPid)
  const owned = new Set(pids)
  const harnessPgrp = readPgrp(process.pid)
  const groups = new Set<number>()
  for (const pid of pids) {
    const pgrp = readPgrp(pid)
    // Only signal groups whose leader is in this owned set. A child that
    // inherited the Harness group (detached: false) must not cause
    // kill(-pgid) to hit the Harness or another invocation.
    if (
      pgrp !== undefined &&
      owned.has(pgrp) &&
      pgrp !== harnessPgrp &&
      !HARNESS_PID_PROTECT().has(pgrp)
    ) {
      groups.add(pgrp)
    }
    signalPid(pid, signal)
  }
  if (signal === "SIGTERM") {
    for (const pgrp of groups) {
      signalProcessGroup(pgrp, signal)
    }
  }
}

const terminateCgroup = (
  invocationId: string,
  cgroupPath: string,
  forceKillAfter: Duration.Input,
  rootPid: number | undefined,
): Effect.Effect<void, InvocationCleanupError> =>
  Effect.gen(function* () {
    signalOwnedMembers(cgroupPath, rootPid, "SIGTERM")

    const forceMs = Duration.toMillis(forceKillAfter)
    const started = yield* Clock.currentTimeMillis
    while ((yield* Clock.currentTimeMillis) - started < forceMs) {
      if (
        collectOwnedPids(cgroupPath, rootPid).length === 0 &&
        cgroupDirRemoved(cgroupPath)
      ) {
        return
      }
      yield* Effect.sleep(Duration.millis(25))
    }

    writeCgroupFile(cgroupPath, "cgroup.kill", "1")
    signalOwnedMembers(cgroupPath, rootPid, "SIGKILL")

    const killStarted = yield* Clock.currentTimeMillis
    while ((yield* Clock.currentTimeMillis) - killStarted < 1_000) {
      signalOwnedMembers(cgroupPath, rootPid, "SIGKILL")
      if (
        collectOwnedPids(cgroupPath, rootPid).length === 0 &&
        cgroupDirRemoved(cgroupPath)
      ) {
        return
      }
      yield* Effect.sleep(Duration.millis(25))
    }

    const leftover = collectOwnedPids(cgroupPath, rootPid)
    if (leftover.length === 0 && cgroupDirRemoved(cgroupPath)) {
      return
    }
    if (leftover.length === 0) {
      return yield* new InvocationCleanupError({
        message: `Invocation cgroup ${cgroupPath} still exists after SIGKILL`,
        invocationId,
        leftoverPids: [],
      })
    }

    return yield* new InvocationCleanupError({
      message: `Invocation cgroup still has processes after SIGKILL: ${leftoverDiagnostics(leftover)}`,
      invocationId,
      leftoverPids: leftover,
    })
  })

/**
 * Terminate every process in the invocation boundary. Idempotent if the
 * cgroup/registry is already gone.
 */
export const terminateInvocation = (
  boundary: InvocationBoundary,
  options: { readonly forceKillAfter?: Duration.Input } = {},
): Effect.Effect<void, InvocationCleanupError> =>
  Effect.gen(function* () {
    const forceKillAfter =
      options.forceKillAfter ?? DEFAULT_INVOCATION_FORCE_KILL_AFTER

    if (boundary.containment.kind === "cgroup") {
      yield* terminateCgroup(
        boundary.id,
        boundary.containment.cgroupPath,
        forceKillAfter,
        boundary.getRootPid(),
      ).pipe(Effect.tap(() => Effect.sync(() => removeRegistry(boundary.id))))
      return
    }

    const rootPid = boundary.getRootPid()
    if (rootPid !== undefined && rootPid > 0) {
      yield* killProcessTree(rootPid, { forceKillAfter })
      if (isProcessAlive(rootPid)) {
        removeRegistry(boundary.id)
        return yield* new InvocationCleanupError({
          message: `Best-effort process-tree cleanup left pid ${rootPid} alive`,
          invocationId: boundary.id,
          leftoverPids: [rootPid],
        })
      }
    }
    removeRegistry(boundary.id)
  }).pipe(Effect.uninterruptible)

/**
 * Establish invocation-scoped ownership before the caller can spawn children.
 * Release terminates remaining owned processes.
 */
export const acquireInvocationBoundary = (
  options: {
    readonly forceKillAfter?: Duration.Input
    readonly onCleanupFailure?: (
      error: InvocationCleanupError,
    ) => Effect.Effect<void>
  } = {},
): Effect.Effect<
  InvocationBoundary,
  InvocationContainmentError,
  import("effect/Scope").Scope
> =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      const created = createBoundary()
      if (created instanceof InvocationContainmentError) {
        return Effect.fail(created)
      }
      if (created.containment.kind === "best_effort") {
        return Effect.logWarning(
          "Invocation Boundary is best-effort; reparented descendants may survive timeout",
          {
            invocationId: created.id,
            platform: process.platform,
            reason: created.containment.reason,
          },
        ).pipe(Effect.as(created))
      }
      return Effect.succeed(created)
    }),
    (boundary) =>
      terminateInvocation(boundary, options).pipe(
        Effect.tapError((error) =>
          recordInvocationCleanupFailure(error).pipe(
            Effect.andThen(
              Effect.logError("Invocation cleanup failed", {
                invocationId: boundary.id,
                message: error.message,
                leftoverPids: error.leftoverPids,
              }),
            ),
            Effect.andThen(
              options.onCleanupFailure !== undefined
                ? options.onCleanupFailure(error)
                : Effect.void,
            ),
          ),
        ),
        Effect.ignore,
      ),
  )

/**
 * After an owned spawn's scope closes, fail success if leftovers remain and
 * attach leftover diagnostics to interrupt/timeout causes.
 */
export const observeOwnedInvocation = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | InvocationCleanupError, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const existing = yield* InvocationCleanupSlot
      const slot =
        existing ??
        (yield* Ref.make<InvocationCleanupError | undefined>(undefined))
      if (existing !== undefined) {
        yield* Ref.set(existing, undefined)
      }
      const inner =
        existing === undefined
          ? effect.pipe(Effect.provideService(InvocationCleanupSlot, slot))
          : effect
      const exit = yield* Effect.exit(restore(inner))
      const leftover = yield* Ref.get(slot)
      if (Exit.isSuccess(exit)) {
        if (leftover !== undefined) {
          return yield* Effect.fail(leftover)
        }
        return exit.value
      }
      if (leftover === undefined) {
        return yield* Effect.failCause(exit.cause)
      }
      return yield* Effect.failCause(
        Cause.combine(exit.cause, Cause.fail(leftover)),
      )
    }),
  )

export const scopedOwned = <A, E, R>(
  effect: Effect.Effect<A, E, R | import("effect/Scope").Scope>,
): Effect.Effect<
  A,
  E | InvocationCleanupError,
  Exclude<R, import("effect/Scope").Scope>
> => observeOwnedInvocation(Effect.scoped(effect))

const pathEntries = (
  env?: Record<string, string | undefined>,
): readonly string[] => {
  const path = env?.PATH ?? process.env.PATH ?? ""
  return path.split(":").filter((dir) => dir.length > 0)
}

/**
 * Resolve an executable so the cgroup wrapper can exec it. Uses the child
 * PATH when provided so test and repository PATH overrides win. Missing
 * binaries stay unresolved so the platform spawn still reports ENOENT
 * instead of a shell exit 127.
 */
const resolveExecutable = (
  binary: string,
  env?: Record<string, string | undefined>,
): string | undefined => {
  if (binary.includes("/") || isAbsolute(binary)) {
    return existsSync(binary) ? binary : undefined
  }
  for (const dir of pathEntries(env)) {
    const candidate = join(dir, binary)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

const cgroupWrappedArgv = (
  binary: string,
  args: ReadonlyArray<string>,
): { readonly command: string; readonly args: string[] } => ({
  command: "/bin/sh",
  args: ["-c", CGROUP_ENTER_SCRIPT, binary, ...args],
})

export const wrapSpawnForBoundary = (
  boundary: InvocationBoundary,
  command: string,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): {
  readonly command: string
  readonly args: string[]
  readonly env: Record<string, string>
} => {
  if (boundary.containment.kind !== "cgroup") {
    return {
      command,
      args: [...args],
      env: { ...env, [INVOCATION_ID_ENV]: boundary.id },
    }
  }
  const resolved = resolveExecutable(command, env)
  if (resolved === undefined) {
    return {
      command,
      args: [...args],
      env: {
        ...env,
        [INVOCATION_CGROUP_ENV]: boundary.containment.cgroupPath,
        [INVOCATION_ID_ENV]: boundary.id,
      },
    }
  }
  const wrapped = cgroupWrappedArgv(resolved, args)
  return {
    command: wrapped.command,
    args: wrapped.args,
    env: {
      ...env,
      [INVOCATION_CGROUP_ENV]: boundary.containment.cgroupPath,
      [INVOCATION_ID_ENV]: boundary.id,
    },
  }
}

export const makeOwnedCommand = (
  boundary: InvocationBoundary,
  binary: string,
  args: ReadonlyArray<string>,
  options: CommandOptions,
) => {
  const env = {
    ...(options.env ?? {}),
    [INVOCATION_ID_ENV]: boundary.id,
    ...(boundary.containment.kind === "cgroup"
      ? { [INVOCATION_CGROUP_ENV]: boundary.containment.cgroupPath }
      : {}),
  }
  if (boundary.containment.kind === "cgroup") {
    const resolved = resolveExecutable(binary, options.env)
    if (resolved !== undefined) {
      const wrapped = cgroupWrappedArgv(resolved, args)
      return ChildProcess.make(wrapped.command, wrapped.args, {
        ...options,
        env,
        detached: options.detached ?? process.platform !== "win32",
      })
    }
  }
  return ChildProcess.make(binary, [...args], {
    ...options,
    env,
    detached: options.detached ?? process.platform !== "win32",
  })
}

/**
 * Spawn `binary` inside an invocation boundary established in the current
 * Scope. The Scope finalizer terminates remaining owned processes.
 */
export const spawnOwnedProcess = (
  spawner: ChildProcessSpawner["Service"],
  binary: string,
  args: ReadonlyArray<string>,
  options: CommandOptions,
): Effect.Effect<
  ChildProcessHandle,
  PlatformError | InvocationContainmentError,
  import("effect/Scope").Scope
> =>
  Effect.gen(function* () {
    const boundary = yield* acquireInvocationBoundary({
      forceKillAfter: options.forceKillAfter,
    })
    const handle = yield* spawner.spawn(
      makeOwnedCommand(boundary, binary, args, options),
    )
    const pid = Number(handle.pid)
    if (Number.isFinite(pid) && pid > 0) {
      boundary.bindRootPid(pid)
    }
    return handle
  })

export const isInvocationCleanupError = (
  value: unknown,
): value is InvocationCleanupError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "InvocationCleanupError"

const cleanupFailureText = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined
  }
  if (!("cleanupFailure" in value)) {
    return undefined
  }
  const text = (value as { cleanupFailure?: unknown }).cleanupFailure
  return typeof text === "string" && text.length > 0 ? text : undefined
}

const cleanupFromUnknown = (
  value: unknown,
): InvocationCleanupError | string | undefined => {
  if (isInvocationCleanupError(value)) {
    return value
  }
  return cleanupFailureText(value)
}

export const findInvocationCleanupFailure = (
  cause: Cause.Cause<unknown>,
): InvocationCleanupError | string | undefined => {
  const direct = Cause.findErrorOption(cause)
  if (Option.isSome(direct)) {
    const found = cleanupFromUnknown(direct.value)
    if (found !== undefined) {
      return found
    }
  }
  for (const error of Cause.prettyErrors(cause)) {
    const fromError = cleanupFromUnknown(error)
    if (fromError !== undefined) {
      return fromError
    }
    let current: unknown = error.cause
    while (current !== undefined && current !== null) {
      const nested = cleanupFromUnknown(current)
      if (nested !== undefined) {
        return nested
      }
      if (typeof current === "object" && "cause" in current) {
        current = (current as { cause: unknown }).cause
        continue
      }
      break
    }
  }
  return undefined
}

export const findInvocationCleanupError = (
  cause: Cause.Cause<unknown>,
): InvocationCleanupError | undefined => {
  const found = findInvocationCleanupFailure(cause)
  return isInvocationCleanupError(found) ? found : undefined
}

export const appendCleanupDiagnostics = (
  message: string,
  cleanup: InvocationCleanupError | string | undefined,
): string => {
  if (cleanup === undefined) {
    return message
  }
  const detail = typeof cleanup === "string" ? cleanup : cleanup.message
  if (detail.length === 0) {
    return message
  }
  return `${message}\nInvocation cleanup failed: ${detail}`
}

export const interruptIsInitiatingReason = (
  cause: Cause.Cause<unknown>,
): boolean => {
  if (Cause.hasInterruptsOnly(cause)) {
    return true
  }
  if (!Cause.hasInterrupts(cause)) {
    return false
  }
  const cleanup = findInvocationCleanupError(cause)
  if (cleanup === undefined) {
    return false
  }
  const error = Cause.findErrorOption(cause)
  return Option.isSome(error) && isInvocationCleanupError(error.value)
}

const sameHarnessProcess = (record: InvocationRegistryRecord): boolean => {
  if (record.harnessPid === process.pid) {
    const current = readStarttime(process.pid)
    if (record.harnessStarttime === undefined || current === undefined) {
      return true
    }
    return record.harnessStarttime === current
  }
  if (!isProcessAlive(record.harnessPid)) {
    return false
  }
  if (record.harnessStarttime === undefined) {
    return true
  }
  return readStarttime(record.harnessPid) === record.harnessStarttime
}

const parseRegistryRecord = (
  raw: string,
): InvocationRegistryRecord | undefined => {
  try {
    const parsed = JSON.parse(raw) as Partial<InvocationRegistryRecord>
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.harnessPid !== "number"
    ) {
      return undefined
    }
    return {
      id: parsed.id,
      harnessPid: parsed.harnessPid,
      ...(typeof parsed.harnessStarttime === "string"
        ? { harnessStarttime: parsed.harnessStarttime }
        : {}),
      ...(typeof parsed.cgroupPath === "string"
        ? { cgroupPath: parsed.cgroupPath }
        : {}),
      createdAt:
        typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    }
  } catch {
    return undefined
  }
}

/**
 * Reap invocation cgroups whose creating Harness process is gone. Live
 * invocations of this or another running Harness are left untouched.
 * Registry records stay when leftover pids remain so a later startup can retry.
 */
export const reapAbandonedInvocations = Effect.gen(function* () {
  let dir: string[]
  try {
    dir = readdirSync(invocationRegistryDirectory())
  } catch {
    return
  }
  for (const name of dir) {
    if (!name.endsWith(".json")) continue
    const path = join(invocationRegistryDirectory(), name)
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch {
      continue
    }
    const record = parseRegistryRecord(raw)
    if (record === undefined) {
      try {
        unlinkSync(path)
      } catch {
        // Ignore.
      }
      continue
    }
    if (sameHarnessProcess(record)) {
      continue
    }
    if (record.cgroupPath !== undefined) {
      writeCgroupFile(record.cgroupPath, "cgroup.kill", "1")
      for (const pid of listCgroupPids(record.cgroupPath)) {
        signalPid(pid, "SIGKILL")
      }
      const started = yield* Clock.currentTimeMillis
      while ((yield* Clock.currentTimeMillis) - started < 250) {
        if (listCgroupPids(record.cgroupPath).length === 0) {
          break
        }
        yield* Effect.sleep(Duration.millis(25))
      }
      for (const pid of listCgroupPids(record.cgroupPath)) {
        signalPid(pid, "SIGKILL")
      }
      if (listCgroupPids(record.cgroupPath).length > 0) {
        continue
      }
      if (!cgroupDirRemoved(record.cgroupPath)) {
        continue
      }
    }
    try {
      unlinkSync(path)
    } catch {
      // Ignore.
    }
  }
})
