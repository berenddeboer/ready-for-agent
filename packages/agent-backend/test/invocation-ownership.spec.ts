import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, Duration, Effect, Exit, Fiber, Ref } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  AgentBackendTimeoutError,
  InvocationCleanupError,
  InvocationCleanupSlot,
  findInvocationCleanupError,
  findInvocationCleanupFailure,
  findWritableLinuxCgroupParent,
  isProcessAlive,
  linuxCgroupParentCandidates,
  observeOwnedInvocation,
  recordInvocationCleanupFailure,
  runCliTurn,
  sanitizeInheritedEnvironment,
  scopedOwned,
  spawnOwnedProcess,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const TEST_BACKEND = { id: "claude" as const, label: "Claude Code" }

const linuxCgroupAvailable = (): boolean =>
  process.platform === "linux" && findWritableLinuxCgroupParent() !== undefined

const requireLinuxCgroup = () => {
  if (process.platform !== "linux") {
    return false
  }
  if (!linuxCgroupAvailable()) {
    throw new Error(
      "Linux tests require a writable cgroup v2 parent so invocation ownership can contain reparented descendants",
    )
  }
  return true
}

const withExecutable = async <A>(
  body: string,
  use: (path: string) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "rfa-invocation-"))
  const path = join(directory, "fake-cli")
  try {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o700)
    return await use(path)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const withSpawner = <A, E>(
  use: (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* use(spawner)
  }).pipe(Effect.provide(BunServices.layer))

const parseSimpleLine = (line: string) => {
  try {
    const parsed = JSON.parse(line) as { sessionID?: string; text?: string }
    return {
      ...(typeof parsed.sessionID === "string"
        ? { sessionId: parsed.sessionID }
        : {}),
      ...(typeof parsed.text === "string" ? { text: parsed.text } : {}),
    }
  } catch {
    return {}
  }
}

const reparentingWorkerPrelude = (pidFile: string) =>
  [
    `sh -c 'setsid -f sh -c "echo \\$\\$ > \\"${pidFile}\\"; exec sleep 100" </dev/null >/dev/null 2>&1'`,
    `while [ ! -s "${pidFile}" ]; do sleep 0.01; done`,
  ].join("\n")

const waitUntilDead = async (pid: number, timeoutMs = 2_000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return
    }
    await Bun.sleep(25)
  }
}

describe("invocation ownership", () => {
  it("documents best-effort containment off Linux", () => {
    if (process.platform === "linux") {
      expect(linuxCgroupAvailable()).toBe(true)
      return
    }
    expect(["darwin", "win32"]).toContain(process.platform)
  })

  it("includes the process cgroup as a Linux mkdir parent", () => {
    if (!requireLinuxCgroup()) return
    const text = readFileSync("/proc/self/cgroup", "utf8")
    const rel = text
      .split("\n")
      .find((entry) => entry.startsWith("0::"))
      ?.slice(3)
      .trim()
    expect(rel !== undefined && rel.length > 0).toBe(true)
    const selfPath = join(
      "/sys/fs/cgroup",
      rel!.startsWith("/") ? rel!.slice(1) : rel!,
    )
    expect(linuxCgroupParentCandidates()).toContain(selfPath)
  })

  it("kills a reparented setsid worker on timeout and leaves a concurrent invocation alive", async () => {
    if (!requireLinuxCgroup()) return
    const markerDir = await mkdtemp(join(tmpdir(), "rfa-reparent-timeout-"))
    const workerPidFile = join(markerDir, "worker.pid")
    const otherPidFile = join(markerDir, "other.pid")
    try {
      const other = spawn(
        "sh",
        ["-c", `echo $$ > "${otherPidFile}"; exec sleep 100`],
        { detached: true, stdio: "ignore" },
      )
      other.unref()
      await withExecutable(
        [
          reparentingWorkerPrelude(workerPidFile),
          `printf '%s\\n' '{"sessionID":"ses_reparent"}'`,
          "sleep 100",
        ].join("\n"),
        async (binary) => {
          const error = await Effect.runPromise(
            withSpawner((spawner) =>
              runCliTurn({
                spawner,
                backend: TEST_BACKEND,
                binary,
                args: [],
                cwd: process.cwd(),
                env: sanitizeInheritedEnvironment(),
                timeout: Duration.millis(500),
                parseLine: parseSimpleLine,
                forceKillAfter: Duration.millis(100),
              }).pipe(Effect.flip),
            ),
          )
          expect(error).toBeInstanceOf(AgentBackendTimeoutError)

          const workerPid = Number(
            (
              await Bun.file(workerPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(workerPid) && workerPid > 0).toBe(true)
          await waitUntilDead(workerPid)
          expect(isProcessAlive(workerPid)).toBe(false)

          const otherPid = Number(
            (
              await Bun.file(otherPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(otherPid) && otherPid > 0).toBe(true)
          expect(isProcessAlive(otherPid)).toBe(true)
          expect(isProcessAlive(process.pid)).toBe(true)
        },
      )
    } finally {
      const otherPid = Number(
        (
          await Bun.file(otherPidFile)
            .text()
            .catch(() => "")
        ).trim(),
      )
      if (Number.isFinite(otherPid) && otherPid > 0) {
        try {
          process.kill(otherPid, "SIGKILL")
        } catch {
          // Already gone.
        }
      }
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("kills a reparented setsid worker on fiber interruption", async () => {
    if (!requireLinuxCgroup()) return
    const markerDir = await mkdtemp(join(tmpdir(), "rfa-reparent-interrupt-"))
    const workerPidFile = join(markerDir, "worker.pid")
    try {
      await withExecutable(
        [
          reparentingWorkerPrelude(workerPidFile),
          `printf '%s\\n' '{"sessionID":"ses_interrupt"}'`,
          "sleep 100",
        ].join("\n"),
        async (binary) => {
          await Effect.runPromise(
            withSpawner((spawner) =>
              Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(
                  runCliTurn({
                    spawner,
                    backend: TEST_BACKEND,
                    binary,
                    args: [],
                    cwd: process.cwd(),
                    env: sanitizeInheritedEnvironment(),
                    timeout: Duration.seconds(30),
                    parseLine: parseSimpleLine,
                    forceKillAfter: Duration.millis(100),
                  }),
                )
                yield* Effect.sleep("500 millis")
                yield* Fiber.interrupt(fiber)
                return yield* Fiber.await(fiber)
              }),
            ),
          )
          const workerPid = Number(
            (
              await Bun.file(workerPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(workerPid) && workerPid > 0).toBe(true)
          await waitUntilDead(workerPid)
          expect(isProcessAlive(workerPid)).toBe(false)
        },
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("reaps a surviving child after a successful agent exit", async () => {
    if (!requireLinuxCgroup()) return
    const markerDir = await mkdtemp(join(tmpdir(), "rfa-success-child-"))
    const workerPidFile = join(markerDir, "worker.pid")
    try {
      await withExecutable(
        [
          reparentingWorkerPrelude(workerPidFile),
          `printf '%s\\n' '{"sessionID":"ses_ok","text":"done"}'`,
        ].join("\n"),
        async (binary) => {
          const result = await Effect.runPromise(
            withSpawner((spawner) =>
              runCliTurn({
                spawner,
                backend: TEST_BACKEND,
                binary,
                args: [],
                cwd: process.cwd(),
                env: sanitizeInheritedEnvironment(),
                timeout: Duration.seconds(5),
                parseLine: parseSimpleLine,
                forceKillAfter: Duration.millis(100),
              }),
            ),
          )
          expect(result).toEqual({
            sessionId: "ses_ok",
            assistantText: "done",
          })
          const workerPid = Number(
            (
              await Bun.file(workerPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(workerPid) && workerPid > 0).toBe(true)
          await waitUntilDead(workerPid)
          expect(isProcessAlive(workerPid)).toBe(false)
        },
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("escalates past a SIGTERM-resistant child and leaves an unrelated process alive", async () => {
    if (!requireLinuxCgroup()) return
    const markerDir = await mkdtemp(join(tmpdir(), "rfa-term-resistant-"))
    const workerPidFile = join(markerDir, "worker.pid")
    const otherPidFile = join(markerDir, "other.pid")
    try {
      const other = spawn(
        "sh",
        ["-c", `echo $$ > "${otherPidFile}"; exec sleep 100`],
        { detached: true, stdio: "ignore" },
      )
      other.unref()
      await withExecutable(
        [
          `sh -c 'setsid -f sh -c "trap \\"\\" TERM; echo \\$\\$ > \\"${workerPidFile}\\"; exec sleep 100" </dev/null >/dev/null 2>&1'`,
          `while [ ! -s "${workerPidFile}" ]; do sleep 0.01; done`,
          `printf '%s\\n' '{"sessionID":"ses_resist"}'`,
          "sleep 100",
        ].join("\n"),
        async (binary) => {
          await Effect.runPromise(
            withSpawner((spawner) =>
              runCliTurn({
                spawner,
                backend: TEST_BACKEND,
                binary,
                args: [],
                cwd: process.cwd(),
                env: sanitizeInheritedEnvironment(),
                timeout: Duration.millis(500),
                parseLine: parseSimpleLine,
                forceKillAfter: Duration.millis(150),
              }).pipe(Effect.flip),
            ),
          )
          const workerPid = Number(
            (
              await Bun.file(workerPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(Number.isFinite(workerPid) && workerPid > 0).toBe(true)
          await waitUntilDead(workerPid)
          expect(isProcessAlive(workerPid)).toBe(false)
          const otherPid = Number(
            (
              await Bun.file(otherPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          expect(isProcessAlive(otherPid)).toBe(true)
        },
      )
    } finally {
      const otherPid = Number(
        (
          await Bun.file(otherPidFile)
            .text()
            .catch(() => "")
        ).trim(),
      )
      if (Number.isFinite(otherPid) && otherPid > 0) {
        try {
          process.kill(otherPid, "SIGKILL")
        } catch {
          // Already gone.
        }
      }
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("releases a file lock after timeout so a retry can acquire it immediately", async () => {
    if (!requireLinuxCgroup()) return
    const markerDir = await mkdtemp(join(tmpdir(), "rfa-lock-timeout-"))
    const lockFile = join(markerDir, "build.lock")
    const workerPidFile = join(markerDir, "worker.pid")
    try {
      await withExecutable(
        [
          `sh -c 'setsid -f sh -c "exec 9>\\"${lockFile}\\"; flock -x 9; echo \\$\\$ > \\"${workerPidFile}\\"; sleep 100" </dev/null >/dev/null 2>&1'`,
          `while [ ! -s "${workerPidFile}" ]; do sleep 0.01; done`,
          "sleep 100",
        ].join("\n"),
        async (binary) => {
          const error = await Effect.runPromise(
            withSpawner((spawner) =>
              Effect.scoped(
                spawnOwnedProcess(spawner, binary, [], {
                  cwd: process.cwd(),
                  env: sanitizeInheritedEnvironment(),
                  extendEnv: false,
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                  forceKillAfter: Duration.millis(100),
                }).pipe(
                  Effect.flatMap((handle) =>
                    handle.exitCode.pipe(Effect.timeout(Duration.millis(500))),
                  ),
                ),
              ).pipe(Effect.flip),
            ),
          )
          expect(error._tag).toBe("TimeoutError")
          const workerPid = Number(
            (
              await Bun.file(workerPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          await waitUntilDead(workerPid)
          expect(isProcessAlive(workerPid)).toBe(false)

          const retry = spawn("flock", ["-n", lockFile, "true"], {
            stdio: "ignore",
          })
          const retryCode = await new Promise<number>((resolve) => {
            retry.on("exit", (code) => resolve(code ?? 1))
          })
          expect(retryCode).toBe(0)
        },
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("releases a file lock after operator Interrupt so a retry can acquire it immediately", async () => {
    if (!requireLinuxCgroup()) return
    const markerDir = await mkdtemp(join(tmpdir(), "rfa-lock-interrupt-"))
    const lockFile = join(markerDir, "build.lock")
    const workerPidFile = join(markerDir, "worker.pid")
    try {
      await withExecutable(
        [
          `sh -c 'setsid -f sh -c "exec 9>\\"${lockFile}\\"; flock -x 9; echo \\$\\$ > \\"${workerPidFile}\\"; sleep 100" </dev/null >/dev/null 2>&1'`,
          `while [ ! -s "${workerPidFile}" ]; do sleep 0.01; done`,
          "sleep 100",
        ].join("\n"),
        async (binary) => {
          await Effect.runPromise(
            withSpawner((spawner) =>
              Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(
                  Effect.scoped(
                    spawnOwnedProcess(spawner, binary, [], {
                      cwd: process.cwd(),
                      env: sanitizeInheritedEnvironment(),
                      extendEnv: false,
                      stdin: "ignore",
                      stdout: "ignore",
                      stderr: "ignore",
                      forceKillAfter: Duration.millis(100),
                    }).pipe(Effect.flatMap((handle) => handle.exitCode)),
                  ),
                )
                yield* Effect.sleep("400 millis")
                yield* Fiber.interrupt(fiber)
                return yield* Fiber.await(fiber)
              }),
            ),
          )
          const workerPid = Number(
            (
              await Bun.file(workerPidFile)
                .text()
                .catch(() => "")
            ).trim(),
          )
          await waitUntilDead(workerPid)
          expect(isProcessAlive(workerPid)).toBe(false)
          const retry = spawn("flock", ["-n", lockFile, "true"], {
            stdio: "ignore",
          })
          const retryCode = await new Promise<number>((resolve) => {
            retry.on("exit", (code) => resolve(code ?? 1))
          })
          expect(retryCode).toBe(0)
        },
      )
    } finally {
      await rm(markerDir, { recursive: true, force: true })
    }
  })

  it("returns the inner success when invocation leftovers are absent", async () => {
    const result = await Effect.runPromise(
      observeOwnedInvocation(Effect.succeed("ok")),
    )
    expect(result).toBe("ok")
  })

  it("fails a successful owned invocation when leftovers remain", async () => {
    const leftover = new InvocationCleanupError({
      message: "Invocation cgroup still has processes after SIGKILL: 1234",
      invocationId: "inv-leftover-success",
      leftoverPids: [1234],
    })
    const error = await Effect.runPromise(
      observeOwnedInvocation(
        recordInvocationCleanupFailure(leftover).pipe(
          Effect.andThen(Effect.succeed("ok")),
        ),
      ).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(InvocationCleanupError)
    expect(error.message).toContain("still has processes after SIGKILL")
  })

  it("reads leftover text from AgentBackendTimeoutError.cleanupFailure", () => {
    const timeout = new AgentBackendTimeoutError({
      cwd: "/tmp",
      timeoutMs: 1,
      cleanupFailure: "still has processes after SIGKILL: 1234",
    })
    expect(findInvocationCleanupFailure(Cause.fail(timeout))).toBe(
      "still has processes after SIGKILL: 1234",
    )
  })

  it("preserves leftover on an outer cleanup slot when the inner cause is rewritten", async () => {
    const leftover = new InvocationCleanupError({
      message: "Invocation cgroup still has processes after SIGKILL: 9012",
      invocationId: "inv-leftover-slot",
      leftoverPids: [9012],
    })
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const leftoverSlot = yield* Ref.make<
          InvocationCleanupError | undefined
        >(undefined)
        yield* observeOwnedInvocation(
          recordInvocationCleanupFailure(leftover).pipe(
            Effect.andThen(Effect.succeed("ok")),
          ),
        ).pipe(
          Effect.provideService(InvocationCleanupSlot, leftoverSlot),
          Effect.flip,
        )
        return yield* Ref.get(leftoverSlot)
      }),
    )
    expect(stored).toBeInstanceOf(InvocationCleanupError)
    expect(stored?.message).toContain("still has processes after SIGKILL: 9012")
  })

  it("attaches leftover diagnostics without dropping the initiating TimeoutError", async () => {
    const leftover = new InvocationCleanupError({
      message: "Invocation cgroup still has processes after SIGKILL: 5678",
      invocationId: "inv-leftover-timeout",
      leftoverPids: [5678],
    })
    const exit = await Effect.runPromise(
      observeOwnedInvocation(
        recordInvocationCleanupFailure(leftover).pipe(
          Effect.andThen(Effect.fail(new Cause.TimeoutError())),
        ),
      ).pipe(Effect.exit),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) {
      return
    }
    expect(findInvocationCleanupError(exit.cause)).toBeDefined()
    const pretty = Cause.prettyErrors(exit.cause)
    expect(
      pretty.some(
        (error) =>
          error.name === "TimeoutError" ||
          (error as { _tag?: string })._tag === "TimeoutError",
      ),
    ).toBe(true)
  })

  it("does not signal the Harness process group for a non-detached owned child", async () => {
    if (!requireLinuxCgroup()) return
    const markerDir = await mkdtemp(join(tmpdir(), "rfa-shared-pgrp-"))
    const siblingPidFile = join(markerDir, "sibling.pid")
    const sibling = spawn(
      "sh",
      ["-c", `echo $$ > "${siblingPidFile}"; exec sleep 30`],
      { detached: false, stdio: "ignore" },
    )
    try {
      await withExecutable("sleep 100", async (binary) => {
        await Effect.runPromise(
          withSpawner((spawner) =>
            scopedOwned(
              spawnOwnedProcess(spawner, binary, [], {
                cwd: process.cwd(),
                env: sanitizeInheritedEnvironment(),
                extendEnv: false,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
                detached: false,
                forceKillAfter: Duration.millis(100),
              }).pipe(
                Effect.flatMap((handle) =>
                  handle.exitCode.pipe(Effect.timeout(Duration.millis(400))),
                ),
              ),
            ).pipe(Effect.flip),
          ),
        )
      })
      expect(isProcessAlive(process.pid)).toBe(true)
      const siblingPid = Number(
        (
          await Bun.file(siblingPidFile)
            .text()
            .catch(() => "")
        ).trim(),
      )
      const livePid =
        Number.isFinite(siblingPid) && siblingPid > 0 ? siblingPid : sibling.pid
      expect(livePid).toBeDefined()
      expect(isProcessAlive(livePid!)).toBe(true)
    } finally {
      if (sibling.pid !== undefined) {
        try {
          process.kill(sibling.pid, "SIGKILL")
        } catch {
          // Already gone.
        }
      }
      await rm(markerDir, { recursive: true, force: true })
    }
  })
})
