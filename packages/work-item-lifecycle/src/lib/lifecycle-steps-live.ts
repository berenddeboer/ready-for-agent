import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { SqlClient } from "effect/unstable/sql"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import { commit } from "./commit.js"
import { createPr } from "./create-pr.js"
import { createWorktree } from "./create-worktree.js"
import { decidePrMerge } from "./decide-pr-merge.js"
import { implement } from "./implement.js"
import { installDependencies } from "./install-dependencies.js"
import { LifecycleSteps } from "./lifecycle-steps.js"
import { markPrReadyForReview } from "./mark-pr-ready-for-review.js"
import {
  investigatePrStatusChecks,
  watchPrStatusChecks,
} from "./pr-status-checks.js"
import { preCommit } from "./pre-commit.js"
import { removeWorktree } from "./remove-worktree.js"
import { review } from "./review.js"

/**
 * Production LifecycleSteps: Create Worktree, Install Dependencies, Implement,
 * Pre-Commit, Review, Commit, and Create PR (OpenCode continues the Implement
 * Session for Review, Commit, and Create PR; Pre-Commit remains harness git
 * validation). Captures platform, database, Keymaxxer, and OpenCode services so
 * handlers remain `Effect<A>` with no requirements.
 */
export const LifecycleStepsLive = Layer.effect(
  LifecycleSteps,
  Effect.gen(function* () {
    const db = yield* DbService
    const keymaxxer = yield* KeymaxxerService
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const opencode = yield* Opencode
    const github = yield* GitHubService
    const sql = yield* SqlClient.SqlClient

    const withServices = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | DbService
        | KeymaxxerService
        | FileSystem.FileSystem
        | Path.Path
        | ChildProcessSpawner.ChildProcessSpawner
        | Opencode
        | GitHubService
        | SqlClient.SqlClient
      >,
    ) =>
      effect.pipe(
        Effect.provideService(DbService, db),
        Effect.provideService(KeymaxxerService, keymaxxer),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Opencode, opencode),
        Effect.provideService(GitHubService, github),
        Effect.provideService(SqlClient.SqlClient, sql),
      )

    return LifecycleSteps.of({
      createWorktree: (context) => withServices(createWorktree(context)),
      installDependencies: (context) =>
        withServices(installDependencies(context)),
      implement: (context) => withServices(implement(context)),
      preCommit: (context) => withServices(preCommit(context)),
      review: (context) => withServices(review(context)),
      commit: (context) => withServices(commit(context)),
      createPr: (context) => withServices(createPr(context)),
      watchPrStatusChecks: (context) =>
        withServices(watchPrStatusChecks(context)),
      investigatePrStatusChecks: (context) =>
        withServices(investigatePrStatusChecks(context)),
      markPrReadyForReview: (context) =>
        withServices(markPrReadyForReview(context)),
      decidePrMerge: (context) => withServices(decidePrMerge(context)),
      removeWorktree: (context) => withServices(removeWorktree(context)),
    })
  }),
)
