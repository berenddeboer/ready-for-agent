import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { SqlClient } from "effect/unstable/sql"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import { assessChanges } from "./assess-changes.js"
import { closeIssue } from "./close-issue.js"
import { commit } from "./commit.js"
import { createPr } from "./create-pr.js"
import { createWorktree } from "./create-worktree.js"
import { decidePrMerge } from "./decide-pr-merge.js"
import { implement } from "./implement.js"
import { installDependencies } from "./install-dependencies.js"
import { LifecycleSteps } from "./lifecycle-steps.js"
import { markPrReadyForReview } from "./mark-pr-ready-for-review.js"
import { mergePr } from "./merge-pr.js"
import { limitOpencodeSessions } from "./opencode-session-limiter.js"
import {
  investigatePrStatusChecks,
  watchPrStatusChecks,
} from "./pr-status-checks.js"
import { preCommit } from "./pre-commit.js"
import { localCleanup, removeWorktree } from "./remove-worktree.js"
import { resolvePrMergeConflict } from "./resolve-pr-merge-conflict.js"
import { review } from "./review.js"

type StepServices =
  | DbService
  | KeymaxxerService
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Opencode
  | GitHubService
  | SqlClient.SqlClient

/**
 * Production LifecycleSteps: Create Worktree through local cleanup, including
 * Assess Changes (git then optional OpenCode confirm) and Close Issue for
 * No-Change Outcomes. Captures platform, database, Keymaxxer, GitHub, and
 * OpenCode services so handlers remain `Effect<A, E>` with no requirements.
 */
export const LifecycleStepsLive = Layer.effect(
  LifecycleSteps,
  Effect.gen(function* () {
    const db = yield* DbService
    const keymaxxer = yield* KeymaxxerService
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const rawOpencode = yield* Opencode
    const github = yield* GitHubService
    const sql = yield* SqlClient.SqlClient
    const opencode = yield* limitOpencodeSessions(rawOpencode, db, sql)

    const services = Layer.mergeAll(
      Layer.succeed(DbService, db),
      Layer.succeed(KeymaxxerService, keymaxxer),
      Layer.succeed(FileSystem.FileSystem, fs),
      Layer.succeed(Path.Path, path),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(Opencode, opencode),
      Layer.succeed(GitHubService, github),
      Layer.succeed(SqlClient.SqlClient, sql),
    )

    const withServices = <A, E>(effect: Effect.Effect<A, E, StepServices>) =>
      effect.pipe(Effect.provide(services))

    return LifecycleSteps.of({
      createWorktree: (context) => withServices(createWorktree(context)),
      installDependencies: (context) =>
        withServices(installDependencies(context)),
      implement: (context) => withServices(implement(context)),
      assessChanges: (context) => withServices(assessChanges(context)),
      preCommit: (context) => withServices(preCommit(context)),
      review: (context) => withServices(review(context)),
      commit: (context) => withServices(commit(context)),
      createPr: (context) => withServices(createPr(context)),
      watchPrStatusChecks: (context) =>
        withServices(watchPrStatusChecks(context)),
      resolvePrMergeConflict: (context) =>
        withServices(resolvePrMergeConflict(context)),
      investigatePrStatusChecks: (context) =>
        withServices(investigatePrStatusChecks(context)),
      markPrReadyForReview: (context) =>
        withServices(markPrReadyForReview(context)),
      decidePrMerge: (context) => withServices(decidePrMerge(context)),
      mergePr: (context) => withServices(mergePr(context)),
      closeIssue: (context) => withServices(closeIssue(context)),
      localCleanup: (context) => withServices(localCleanup(context)),
      removeWorktree: (context) => withServices(removeWorktree(context)),
    })
  }),
)
