import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, Fiber } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  acquireInvocation,
  invocationCommand,
  requireInvocationContainment,
  runCliTurn,
  sanitizeInheritedEnvironment,
  spawnOwned,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const alive = async (pid: number) => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z"
  } catch {
    return false
  }
}

// Both intermediaries exit before the agent announces readiness. The worker
// owns a new session, ignores TERM, and holds a real lock until it is killed.
const worker = `import os, signal, fcntl, time, sys
if os.fork():
    os.wait()
    sys.exit()
os.setsid()
if os.fork(): os._exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
f = open("resource.lock", "w")
fcntl.flock(f, fcntl.LOCK_EX)
open("worker.pid", "w").write(str(os.getpid()))
while True: time.sleep(1)
`

describe("invocation ownership", () => {
  for (const ending of [
    "timeout",
    "interrupt",
    "success",
    "finalize",
  ] as const) {
    it(`reaps a reparented TERM-resistant worker after ${ending}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "rfa-ownership-"))
      let pid = 0
      try {
        await writeFile(join(cwd, "worker.py"), worker)
        const program = Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const unrelated = yield* spawnOwned(
              spawner,
              ChildProcess.make("/bin/sleep", ["100"], {
                cwd: tmpdir(),
                forceKillAfter: "100 millis",
              }),
            )
            const turn = runCliTurn({
              spawner,
              backend: { id: "codex", label: "fixture" },
              binary: "/bin/sh",
              args: [
                "-c",
                `python3 worker.py </dev/null; while [ ! -s worker.pid ]; do sleep 0.01; done; printf 'ready\\n'; ${ending === "success" ? "exit 0" : "sleep 100"}`,
              ],
              cwd,
              env: sanitizeInheritedEnvironment(),
              timeout: "700 millis",
              forceKillAfter: "100 millis",
              parseLine: () => ({
                sessionId: "same-session",
                ...(ending === "finalize" ? { finalizeText: "done" } : {}),
              }),
            })
            const result = yield* Effect.gen(function* () {
              if (ending !== "interrupt") return yield* Effect.exit(turn)
              const fiber = yield* Effect.forkChild(turn)
              yield* Effect.sleep("500 millis")
              yield* Fiber.interrupt(fiber)
              return yield* Fiber.await(fiber)
            })
            expect(yield* unrelated.isRunning).toBe(true)
            return result
          }),
        ).pipe(Effect.provide(BunServices.layer))
        const started = Date.now()
        const exit = await Effect.runPromise(program)
        pid = Number(
          await readFile(join(cwd, "worker.pid"), "utf8").catch(() => {
            throw new Error(JSON.stringify(exit))
          }),
        )
        expect(pid).toBeGreaterThan(1)
        expect(await alive(pid)).toBe(false)
        expect(Date.now() - started).toBeLessThan(4_000)
        expect(Exit.isSuccess(exit)).toBe(
          ending === "success" || ending === "finalize",
        )
        const lock = Bun.spawn([
          "flock",
          "-n",
          join(cwd, "resource.lock"),
          "true",
        ])
        expect(await lock.exited).toBe(0)
      } finally {
        if (pid === 0)
          pid = Number(
            await readFile(join(cwd, "worker.pid"), "utf8").catch(() => "0"),
          )
        if (pid > 1 && (await alive(pid))) process.kill(pid, "SIGKILL")
        await rm(cwd, { recursive: true, force: true })
      }
    }, 10_000)
  }
})

// Platform policy is deliberate: neither setsid nor taskkill proves ownership.
it("rejects platforms without a durable containment implementation", () => {
  for (const platform of ["darwin", "win32", "freebsd"] as const) {
    expect(() => requireInvocationContainment(platform)).toThrow("Linux")
  }
})

it("rejects a revoked launch gate before executing repository code", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rfa-revoked-"))
  try {
    const launch = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const boundary = yield* acquireInvocation({
            cwd,
            forceKillAfter: "100 millis",
          })
          return invocationCommand(boundary.membership, "/bin/sh", [
            "-c",
            "touch should-not-exist",
          ])
        }),
      ),
    )
    const process = Bun.spawn([launch.command, ...launch.args], {
      cwd,
      stderr: "ignore",
    })
    expect(await process.exited).not.toBe(0)
    expect(await Bun.file(join(cwd, "should-not-exist")).exists()).toBe(false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

it("reaps a crashed Harness invocation on replacement without touching a live peer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rfa-recovery-"))
  const peerCwd = await mkdtemp(join(tmpdir(), "rfa-peer-"))
  const fixture = join(import.meta.dir, "fixtures/ownership-host.ts")
  const hosts: ReturnType<typeof Bun.spawn>[] = []
  const workers: number[] = []
  let unit = ""
  try {
    for (const directory of [cwd, peerCwd]) {
      await writeFile(join(directory, "worker.py"), worker)
      hosts.push(
        Bun.spawn([process.execPath, fixture, directory], {
          stdout: "ignore",
          stderr: "inherit",
        }),
      )
      const deadline = Date.now() + 5_000
      while (
        !(await Bun.file(join(directory, "worker.pid")).exists()) &&
        Date.now() < deadline
      )
        await Bun.sleep(20)
      workers.push(
        Number(await readFile(join(directory, "worker.pid"), "utf8")),
      )
    }
    const [orphan, peer] = workers
    if (!orphan || !peer) throw new Error("fixture did not start")
    const membership = await readFile(`/proc/${orphan}/cgroup`, "utf8")
    unit =
      membership.split("/").find((segment) => segment.startsWith("rfa-inv-")) ??
      ""
    expect(unit.endsWith(".service")).toBe(true)
    // Pause the watchdog so this specifically exercises restart recovery, not
    // its automatic owner-death detection (covered by the next test).
    const show = Bun.spawn(
      ["systemctl", "--user", "show", unit, "--property=MainPID", "--value"],
      { stdout: "pipe" },
    )
    const anchor = Number(await new Response(show.stdout).text())
    expect(anchor).toBeGreaterThan(1)
    process.kill(anchor, "SIGSTOP")
    hosts[0]?.kill("SIGKILL")
    await hosts[0]?.exited
    expect(await alive(orphan)).toBe(true)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const boundary = yield* acquireInvocation({
            cwd,
            forceKillAfter: "100 millis",
          })
          expect(boundary.unit).not.toBe(unit)
        }),
      ),
    )
    expect(await alive(orphan)).toBe(false)
    expect(await alive(peer)).toBe(true)
  } finally {
    for (const host of hosts) {
      host.kill("SIGKILL")
      await host.exited
    }
    if (unit)
      await Bun.spawn(["systemctl", "--user", "stop", unit], {
        stderr: "ignore",
      }).exited
    for (const pid of workers)
      if (await alive(pid)) process.kill(pid, "SIGKILL")
    await rm(cwd, { recursive: true, force: true })
    await rm(peerCwd, { recursive: true, force: true })
  }
}, 15_000)

it("automatically reaps an invocation after abrupt Harness death", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rfa-owner-death-"))
  let pid = 0
  let host: ReturnType<typeof Bun.spawn> | undefined
  try {
    await writeFile(join(cwd, "worker.py"), worker)
    host = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/ownership-host.ts"),
        cwd,
      ],
      { stdout: "ignore", stderr: "inherit" },
    )
    const readyDeadline = Date.now() + 5_000
    while (
      !(await Bun.file(join(cwd, "worker.pid")).exists()) &&
      Date.now() < readyDeadline
    )
      await Bun.sleep(20)
    pid = Number(await readFile(join(cwd, "worker.pid"), "utf8"))
    host.kill("SIGKILL")
    await host.exited
    const stopDeadline = Date.now() + 3_000
    while ((await alive(pid)) && Date.now() < stopDeadline) await Bun.sleep(20)
    expect(await alive(pid)).toBe(false)
  } finally {
    host?.kill("SIGKILL")
    await host?.exited
    if (pid > 1 && (await alive(pid))) process.kill(pid, "SIGKILL")
    await rm(cwd, { recursive: true, force: true })
  }
}, 10_000)

for (const ending of ["timeout", "interrupt", "success"] as const) {
  it(`reports cleanup failure separately from ${ending} and blocks reuse until verified`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rfa-cleanup-failure-"))
    const originalBus = process.env.DBUS_SESSION_BUS_ADDRESS
    const originalRuntime = process.env.XDG_RUNTIME_DIR
    let events = ""
    try {
      const attempt = Effect.scoped(
        Effect.gen(function* () {
          const boundary = yield* acquireInvocation({
            cwd,
            forceKillAfter: "100 millis",
          })
          events = join(boundary.membership, "../../cgroup.events")
          // Real OS failure: deny observation of this invocation and disconnect
          // only this test process's manager client. No kill function is mocked.
          yield* Effect.promise(() => chmod(events, 0))
          process.env.DBUS_SESSION_BUS_ADDRESS =
            "unix:path=/does-not-exist-rfa-fixture"
          process.env.XDG_RUNTIME_DIR = "/does-not-exist-rfa-fixture"
          if (ending !== "success") yield* Effect.never
        }),
      )
      const result = await Effect.runPromise(
        ending === "interrupt"
          ? Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(attempt)
              yield* Effect.sleep("300 millis")
              yield* Fiber.interrupt(fiber)
              return yield* Fiber.await(fiber)
            })
          : attempt.pipe(Effect.timeout("300 millis"), Effect.exit),
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        if (ending === "interrupt")
          expect(Cause.hasInterruptsOnly(result.cause)).toBe(true)
        else
          expect(Cause.pretty(result.cause)).toContain(
            ending === "timeout" ? "TimeoutError" : "cleanup",
          )
      }
      const blocked = await Effect.runPromise(
        Effect.scoped(acquireInvocation({ cwd })).pipe(Effect.exit),
      )
      expect(Exit.isFailure(blocked)).toBe(true)
    } finally {
      if (originalBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
      else process.env.DBUS_SESSION_BUS_ADDRESS = originalBus
      if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = originalRuntime
      if (events) await chmod(events, 0o644).catch(() => {})
      // Retrying the same worktree must first clear the failed old boundary.
      await Effect.runPromise(
        Effect.scoped(acquireInvocation({ cwd, forceKillAfter: "100 millis" })),
      )
      await rm(cwd, { recursive: true, force: true })
    }
  }, 10_000)
}
