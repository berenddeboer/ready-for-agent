import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { spawnOwned } from "../../src/lib/invocation-ownership.js"

const cwd = process.argv[2]
if (cwd === undefined) throw new Error("fixture cwd is required")
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawnOwned(
        spawner,
        ChildProcess.make("/bin/sh", ["-c", "python3 worker.py; sleep 100"], {
          cwd,
          stdout: "ignore",
          stderr: "ignore",
          forceKillAfter: "100 millis",
        }),
      )
      yield* Effect.never
    }),
  ).pipe(Effect.provide(BunServices.layer)),
)
