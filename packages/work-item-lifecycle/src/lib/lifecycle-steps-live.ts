import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { DbService } from "@ready-for-agent/db-service"
import { Opencode } from "@ready-for-agent/opencode"
import { createWorktree } from "./create-worktree.js"
import { installDependencies } from "./install-dependencies.js"
import { LifecycleSteps } from "./lifecycle-steps.js"

const notImplemented = (step: string) =>
  Effect.die(new Error(`Lifecycle Step ${step} is not implemented yet`))

/**
 * Production LifecycleSteps: Create Worktree and Install Dependencies;
 * Implement and Review arrive in later tickets.
 * Captures platform, database, and OpenCode services so handlers remain
 * `Effect<A>` with no requirements.
 */
export const LifecycleStepsLive = Layer.effect(
  LifecycleSteps,
  Effect.gen(function* () {
    const db = yield* DbService
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const opencode = yield* Opencode

    const withServices = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | DbService
        | FileSystem.FileSystem
        | Path.Path
        | ChildProcessSpawner.ChildProcessSpawner
        | Opencode
      >,
    ) =>
      effect.pipe(
        Effect.provideService(DbService, db),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Opencode, opencode),
      )

    return LifecycleSteps.of({
      createWorktree: (context) => withServices(createWorktree(context)),
      installDependencies: (context) =>
        withServices(installDependencies(context)),
      implement: () => notImplemented("implement"),
      review: () => notImplemented("review"),
    })
  }),
)
