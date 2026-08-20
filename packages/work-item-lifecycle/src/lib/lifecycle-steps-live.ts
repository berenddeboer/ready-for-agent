import { Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { SqlClient } from "effect/unstable/sql"
import {
  ActiveAgentBackend,
  AgentBackend,
  AgentBackendConfigError,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"
import { AzureDevOpsService } from "@ready-for-agent/azure-devops-service"
import { DbService } from "@ready-for-agent/db-service"
import { GitHubService } from "@ready-for-agent/github-service"
import { GitLabService } from "@ready-for-agent/gitlab-service"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import {
  CurrentCapturedAgentBackendId,
  CurrentStepRun,
  limitAgentTurns,
} from "./agent-turn-limiter.js"
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
  | AgentBackend
  | ActiveAgentBackend
  | GitHubService
  | GitLabService
  | AzureDevOpsService
  | SqlClient.SqlClient

/**
 * Production LifecycleSteps: Create Worktree through local cleanup, including
 * Assess Changes (git then optional OpenCode confirm) and Close Issue for
 * No-Change Outcomes. Captures platform, database, Keymaxxer, GitHub, GitLab,
 * Azure DevOps, Active Agent Backend, and Agent Backend services so handlers
 * remain `Effect<A, E>` with no requirements.
 */
export const LifecycleStepsLive = Layer.effect(
  LifecycleSteps,
  Effect.gen(function* () {
    const db = yield* DbService
    const keymaxxer = yield* KeymaxxerService
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fallbackAgentBackend = yield* AgentBackend
    const activeAgentBackend = yield* ActiveAgentBackend
    const github = yield* GitHubService
    const gitlab = yield* GitLabService
    const azureDevOps = yield* AzureDevOpsService
    const sql = yield* SqlClient.SqlClient
    // Dispatch Agent Turns by the Work Item's captured backend (ambient) so
    // concurrent dual-backend fleets never share the process-wide proxy.
    // Fail closed: non-selectable capture, or null capture while a Step Run
    // fiber is in flight (no silent proxy fallback for lifecycle turns).
    const resolveCapturedBackendId = Effect.gen(function* () {
      const captured = yield* CurrentCapturedAgentBackendId
      if (captured === null) {
        const stepRun = yield* CurrentStepRun
        if (stepRun !== null) {
          return yield* new AgentBackendConfigError({
            message:
              "Work Item captured Agent Backend is missing on an in-flight Step Run",
          })
        }
        return null
      }
      if (!isSelectableAgentBackendId(captured)) {
        return yield* new AgentBackendConfigError({
          message: `Work Item captured Agent Backend is not selectable: ${captured}`,
        })
      }
      return captured
    })
    const routedAgentBackend = AgentBackend.of({
      startTurn: (input) =>
        Effect.gen(function* () {
          const captured = yield* resolveCapturedBackendId
          if (captured === null) {
            return yield* fallbackAgentBackend.startTurn(input)
          }
          return yield* activeAgentBackend.startTurn(captured, input)
        }),
      continueTurn: (input) =>
        Effect.gen(function* () {
          const captured = yield* resolveCapturedBackendId
          if (captured === null) {
            return yield* fallbackAgentBackend.continueTurn(input)
          }
          return yield* activeAgentBackend.continueTurn(captured, input)
        }),
      inspect: (input) =>
        Effect.gen(function* () {
          const captured = yield* resolveCapturedBackendId
          if (captured === null) {
            return yield* fallbackAgentBackend.inspect(input)
          }
          return yield* activeAgentBackend.inspectBackend(captured, input)
        }),
    })
    const agentBackend = yield* limitAgentTurns(routedAgentBackend, db, sql)

    const services = Layer.mergeAll(
      Layer.succeed(DbService, db),
      Layer.succeed(KeymaxxerService, keymaxxer),
      Layer.succeed(FileSystem.FileSystem, fs),
      Layer.succeed(Path.Path, path),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(AgentBackend, agentBackend),
      Layer.succeed(ActiveAgentBackend, activeAgentBackend),
      Layer.succeed(GitHubService, github),
      Layer.succeed(GitLabService, gitlab),
      Layer.succeed(AzureDevOpsService, azureDevOps),
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
