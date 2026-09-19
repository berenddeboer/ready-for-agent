import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, Fiber } from "effect"
import {
  KeymaxxerService,
  disabledKeymaxxerLayer,
} from "@ready-for-agent/keymaxxer-service"
import { runGit } from "../src/lib/git.js"
import { runOwnedWithSecrets } from "../src/lib/repository-process-environment.js"
import { describe, expect, it } from "bun:test"

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
const alive = async (pid: number) => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z"
  } catch {
    return false
  }
}

describe("native repository invocation ownership", () => {
  for (const ending of ["timeout", "interrupt"] as const) {
    for (const route of ["native", "sidecar"] as const) {
      it(`reaps detached Commit hook servers and preserves staged changes after ${ending} via ${route}`, async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rfa-native-ownership-"))
        const repository = { localPath: cwd, isBare: false }
        let pid = 0
        const run = <A, E>(
          effect: Effect.Effect<
            A,
            E,
            import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
          >,
        ) => Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))
        try {
          await run(runGit(repository, ["init"]))
          await run(
            runGit(repository, [
              "config",
              "user.email",
              "fixture@example.invalid",
            ]),
          )
          await run(runGit(repository, ["config", "user.name", "fixture"]))
          await writeFile(join(cwd, "tracked.txt"), "keep this change\n")
          await run(runGit(repository, ["add", "tracked.txt"]))
          await writeFile(join(cwd, "worker.py"), worker)
          await writeFile(
            join(cwd, ".git/hooks/pre-commit"),
            "#!/bin/sh\npython3 worker.py\nwhile [ ! -s worker.pid ]; do sleep 0.01; done\nsleep 100\n",
            { mode: 0o755 },
          )
          const attempt =
            route === "native"
              ? runGit(repository, ["commit", "-m", "fixture"])
              : Effect.gen(function* () {
                  const keymaxxer = yield* KeymaxxerService
                  return yield* runOwnedWithSecrets(keymaxxer, {
                    command: "git commit -m fixture",
                    cwd,
                    secrets: [],
                    timeoutMs: 30_000,
                  })
                }).pipe(Effect.provide(disabledKeymaxxerLayer))
          const started = Date.now()
          const exit = await run(
            ending === "timeout"
              ? attempt.pipe(Effect.timeout("700 millis"), Effect.exit)
              : Effect.gen(function* () {
                  const fiber = yield* Effect.forkChild(attempt)
                  yield* Effect.sleep("500 millis")
                  yield* Fiber.interrupt(fiber)
                  return yield* Fiber.await(fiber)
                }),
          )
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit) && ending === "interrupt")
            expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          expect(Date.now() - started).toBeLessThan(6_000)
          pid = Number(await readFile(join(cwd, "worker.pid"), "utf8"))
          expect(pid).toBeGreaterThan(1)
          expect(await alive(pid)).toBe(false)
          expect(
            (
              await run(runGit(repository, ["diff", "--cached", "--name-only"]))
            ).trim(),
          ).toBe("tracked.txt")
          expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe(
            "keep this change\n",
          )
          await writeFile(
            join(cwd, ".git/hooks/pre-commit"),
            "#!/bin/sh\nexec flock -n resource.lock true\n",
            { mode: 0o755 },
          )
          await run(runGit(repository, ["commit", "-m", "retry"]))
          expect(
            (
              await run(runGit(repository, ["log", "-1", "--format=%s"]))
            ).trim(),
          ).toBe("retry")
        } finally {
          if (pid === 0)
            pid = Number(
              await readFile(join(cwd, "worker.pid"), "utf8").catch(() => "0"),
            )
          if (pid > 1 && (await alive(pid))) process.kill(pid, "SIGKILL")
          await rm(cwd, { recursive: true, force: true })
        }
      }, 15_000)
    }
  }
})
