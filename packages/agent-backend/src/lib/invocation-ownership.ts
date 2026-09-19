import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import { Duration, Effect, Exit } from "effect"
import { PlatformError, systemError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const CONTROL_TIMEOUT_MS = 3_000
const active = new Set<string>()
const failed = new Map<string, Map<string, () => Promise<void>>>()

const control = (
  binary: string,
  args: readonly string[],
  timeout = CONTROL_TIMEOUT_MS,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `${binary} ${args.join(" ")}: ${stderr.trim() || error.message}`,
            ),
          )
        else resolve(stdout.trim())
      },
    )
  })

const missing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT"

const ownerIdentity = async (pid: number) => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return fields[0] === "Z" ? undefined : fields[19]
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

const groupPath = async (unit: string) => {
  const value = await control("systemctl", [
    "--user",
    "show",
    unit,
    "--property=ControlGroup",
    "--value",
  ])
  if (!value) return undefined
  if (
    !value.startsWith("/") ||
    value.split("/").includes("..") ||
    !value.endsWith(`/${unit}`)
  ) {
    throw new Error(`Unexpected cgroup for ${unit}: ${value}`)
  }
  return `/sys/fs/cgroup${value}`
}

const populated = async (path: string) => {
  try {
    const events = await readFile(join(path, "cgroup.events"), "utf8")
    const match = /^populated ([01])$/m.exec(events)
    if (!match) throw new Error(`Cannot verify cgroup population: ${path}`)
    return match[1] === "1"
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

// Removing an empty cgroup also revokes admission through already-open
// cgroup.procs descriptors. A delayed sidecar launch cannot repopulate a boundary
// after cleanup reports success; rmdir fails if a process raced into it.
const removeEmptyGroup = async (
  path: string,
  deadline: number,
): Promise<void> => {
  try {
    if (Date.now() > deadline)
      throw new Error(`Timed out removing invocation cgroup ${path}`)
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory())
        await removeEmptyGroup(join(path, entry.name), deadline)
    }
    await rmdir(path)
  } catch (error) {
    if (!missing(error)) throw error
  }
}

const stopUnit = async (unit: string, graceMs: number, knownPath?: string) => {
  const path = knownPath ?? (await groupPath(unit))
  if (!path) return
  // Stopping the manager-owned anchor closes admission as well as killing the
  // payload. A late launch cannot enter a removed cgroup and cannot exec.
  try {
    await control(
      "systemctl",
      ["--user", "stop", unit],
      graceMs + CONTROL_TIMEOUT_MS,
    )
  } catch {
    /* Verify and force-kill through the kernel even if the manager fails. */
  }
  if (await populated(path)) {
    // Kernel cgroup.kill is recursive and atomic with respect to concurrent forks.
    try {
      await writeFile(join(path, "cgroup.kill"), "1")
    } catch (error) {
      if (!missing(error)) throw error
    }
    const deadline = Date.now() + 1_000
    while ((await populated(path)) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20))
    if (await populated(path))
      throw new Error(
        `Owned processes remain in ${path}; inspect systemctl --user status ${unit}`,
      )
  }
  await removeEmptyGroup(path, Date.now() + 1_000)
}

const ownershipError = (method: string, cwd: string, cause: unknown) =>
  systemError({
    _tag: "Unknown",
    module: "ChildProcess",
    method,
    description: `Invocation containment ${method} failed for ${cwd}. Linux cgroup v2 and a working systemd user manager with delegation are required. ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  })

/** No PPID/group fallback: unsupported hosts fail before repository code runs. */
export const requireInvocationContainment = (platform: NodeJS.Platform) => {
  if (platform !== "linux")
    throw new Error(
      `Durable invocation containment is not implemented on ${platform}; run the Harness on Linux with cgroup v2 and systemd --user`,
    )
}

// The anchor is independent of the Harness. Even SIGKILL of the Harness causes
// systemd to stop this invocation after the identity-checked owner disappears.
const anchorScript = `while IFS= read -r stat < "/proc/$1/stat"; do
  fields=\${stat##*) }
  set -- "$1" "$2" $fields
  [ "$3" != Z ] || exit 0
  shift 2
  shift 19
  [ "$1" = "$expected" ] || exit 0
  set -- "$owner" "$expected"
  /bin/sleep 1
done`

const acquireBoundary = async (cwd: string, graceMs: number) => {
  requireInvocationContainment(process.platform)
  await access("/sys/fs/cgroup/cgroup.controllers")
  const canonical = await realpath(cwd)
  for (const retry of failed.get(canonical)?.values() ?? []) await retry()
  if (failed.get(canonical)?.size === 0) failed.delete(canonical)
  const prefix = `rfa-inv-${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}-`
  const identity = await ownerIdentity(process.pid)
  if (!identity) throw new Error("Cannot establish Harness process identity")
  const units = await control("systemctl", [
    "--user",
    "list-units",
    "--all",
    "--plain",
    "--no-legend",
    `${prefix}*.service`,
  ])
  for (const line of units.split("\n")) {
    const unit = line.trim().split(/\s+/)[0]
    if (!unit || active.has(unit)) continue
    const match = /^rfa-inv-[a-f0-9]{24}-(\d+)-(\d+)-[a-f0-9-]+\.service$/.exec(
      unit,
    )
    if (
      match &&
      ((match[1] === String(process.pid) && match[2] === identity) ||
        (await ownerIdentity(Number(match[1]))) !== match[2])
    )
      await stopUnit(unit, graceMs)
  }
  const unit = `${prefix}${process.pid}-${identity}-${randomUUID()}.service`
  active.add(unit)
  let path: string | undefined
  let stopped = false
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (stopping) return stopping
    stopping = stopUnit(unit, graceMs, path)
      .then(() => {
        stopped = true
        active.delete(unit)
        failed.get(canonical)?.delete(unit)
      })
      .catch((error: unknown) => {
        const failures =
          failed.get(canonical) ?? new Map<string, () => Promise<void>>()
        failures.set(unit, stop)
        failed.set(canonical, failures)
        throw error
      })
      .finally(() => {
        stopping = undefined
      })
    return stopping
  }
  try {
    await control("systemd-run", [
      "--user",
      "--quiet",
      "--collect",
      "--expand-environment=no",
      `--unit=${unit}`,
      "--service-type=exec",
      "--property=Delegate=yes",
      "--property=KillMode=control-group",
      "--property=SendSIGKILL=yes",
      `--property=TimeoutStopSec=${graceMs}ms`,
      "--property=Restart=no",
      "/bin/sh",
      "-c",
      `owner=$1; expected=$2; ${anchorScript}`,
      "rfa-owner",
      String(process.pid),
      identity,
    ])
    path = await groupPath(unit)
    if (!path) throw new Error(`No cgroup was created for ${unit}`)
    await access(join(path, "cgroup.kill"), constants.W_OK)
    // A dedicated leaf keeps payloads out of the delegated anchor's cgroup.
    const payload = join(path, "payload")
    await mkdir(payload)
    await access(join(payload, "cgroup.procs"), constants.W_OK)
    return {
      unit,
      cwd: canonical,
      membership: join(payload, "cgroup.procs"),
      stop,
    }
  } catch (error) {
    try {
      await stop()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Failed to establish and release ${unit}: ${String(error)}; cleanup: ${String(cleanupError)}`,
      )
    }
    throw error
  }
}

/** Shared launch gate for Effect commands and native ACP stdio connections. */
export const acquireInvocation = (input: {
  readonly cwd: string
  readonly forceKillAfter?: Duration.Input
}) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        acquireBoundary(
          input.cwd,
          Math.max(1, Duration.toMillis(input.forceKillAfter ?? "2 seconds")),
        ),
      catch: (cause) => ownershipError("launch", input.cwd, cause),
    }),
    releaseInvocation,
  )

const releaseInvocation = (
  boundary: Awaited<ReturnType<typeof acquireBoundary>>,
  exit: Exit.Exit<unknown, unknown>,
) =>
  Effect.tryPromise({
    try: boundary.stop,
    catch: (cause) => ownershipError("cleanup", boundary.cwd, cause),
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("Invocation cleanup failed; worktree reuse is blocked", {
        unit: boundary.unit,
        cwd: boundary.cwd,
        error,
      }).pipe(
        // Keep timeout / Interrupt as initiating reason; surface cleanup as its
        // own diagnostic. A successful attempt must never conceal failed cleanup.
        Effect.andThen(Exit.isSuccess(exit) ? Effect.die(error) : Effect.void),
      ),
    ),
  )

export const invocationCommand = (
  membership: string,
  command: string,
  args: readonly string[],
) => ({
  command: "/bin/sh",
  args: [
    "-c",
    'printf "%s\\n" "$$" > "$1" || { printf "%s\\n" "Cannot enter invocation cgroup; run the Harness in a delegated systemd user service or scope." >&2; exit 125; }; shift; exec "$@"',
    "rfa-launch",
    membership,
    command,
    ...args,
  ],
})

/** Resolve before wrapping so missing CLI commands retain the existing error. */
const resolveExecutable = async (command: ChildProcess.StandardCommand) => {
  const env =
    command.options.extendEnv === false
      ? command.options.env
      : { ...process.env, ...command.options.env }
  const cwd = command.options.cwd ?? process.cwd()
  const candidates = command.command.includes("/")
    ? [
        isAbsolute(command.command)
          ? command.command
          : resolve(cwd, command.command),
      ]
    : (env?.PATH ?? "/usr/local/bin:/usr/bin:/bin")
        .split(delimiter)
        .map((dir) => resolve(cwd, dir, command.command))
  let denied: PlatformError | undefined
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      if (!(await stat(candidate)).isFile()) {
        denied = systemError({
          _tag: "PermissionDenied",
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: candidate,
          description: "Executable is not a regular file",
          cause: { code: "EACCES" },
        })
        continue
      }
      return candidate
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? cause.code
          : undefined
      if (code === "ENOENT" || code === "ENOTDIR") continue
      const error = systemError({
        _tag:
          code === "EACCES" || code === "EPERM"
            ? "PermissionDenied"
            : "Unknown",
        module: "ChildProcess",
        method: "spawn",
        pathOrDescriptor: candidate,
        description: cause instanceof Error ? cause.message : String(cause),
        cause,
      })
      if (code !== "EACCES" && code !== "EPERM") throw error
      denied = error
    }
  }
  if (denied !== undefined) throw denied
  throw systemError({
    _tag: "NotFound",
    module: "ChildProcess",
    method: "spawn",
    description: `Executable not found: ${command.command}`,
    cause: { code: "ENOENT" },
  })
}

/** Resolve for both CLI and ACP launches before the containment shell starts. */
export const resolveInvocationExecutable = (
  command: ChildProcess.StandardCommand,
) =>
  Effect.tryPromise({
    try: () => resolveExecutable(command),
    catch: (cause) =>
      cause instanceof PlatformError
        ? cause
        : ownershipError(
            "resolve executable",
            command.options.cwd ?? process.cwd(),
            cause,
          ),
  })

/** Every returned handle owns a fresh boundary, even within a durable Session. */
export const spawnOwned = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.StandardCommand,
) =>
  Effect.gen(function* () {
    const binary = yield* resolveInvocationExecutable(command)
    const boundary = yield* acquireInvocation({
      cwd: command.options.cwd ?? process.cwd(),
      forceKillAfter: command.options.forceKillAfter,
    })
    const wrapped = invocationCommand(boundary.membership, binary, command.args)
    const handle = yield* spawner.spawn(
      ChildProcess.make(wrapped.command, wrapped.args, command.options),
    )
    yield* Effect.addFinalizer((exit) => releaseInvocation(boundary, exit))
    const stop = Effect.tryPromise({
      try: boundary.stop,
      catch: (cause) => ownershipError("cleanup", boundary.cwd, cause),
    })
    // Release surviving children at main-process exit, including children holding
    // stdout/stderr open; waiting for EOF before cleanup would deadlock.
    yield* handle.exitCode.pipe(
      Effect.exit,
      Effect.andThen(stop),
      Effect.catch((error) =>
        Effect.logError("Invocation exit cleanup failed", {
          unit: boundary.unit,
          error,
        }),
      ),
      Effect.forkScoped,
    )
    return ChildProcessSpawner.makeHandle({ ...handle, kill: () => stop })
  })
