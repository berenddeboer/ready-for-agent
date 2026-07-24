import { Effect, Layer } from "effect"
import {
  ActiveAgentBackend,
  AgentBackendRestartRequiredError,
  type AgentBackendStatus,
  AgentBackendUnavailableError,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  AgentBackendRestartRequiredError as LifecycleRestartRequiredError,
  LifecycleSteps,
  type LifecycleStepsShape,
  AgentBackendUnavailableError as LifecycleUnavailableError,
  STEP_RUN_REASON,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const successfulSteps: LifecycleStepsShape = {
  createWorktree: () =>
    Effect.succeed({
      worktreePath: "/tmp/worktrees/acme-widgets-42",
      startingCommitOid: "abc123",
    }),
  installDependencies: () => Effect.void,
  implement: () => Effect.succeed("ses_test"),
  assessChanges: () => Effect.succeed({ _tag: "changes" }),
  preCommit: () => Effect.void,
  review: () => Effect.succeed({ _tag: "clean" as const }),
  commit: () => Effect.void,
  createPr: () => Effect.succeed(101),
  watchPrStatusChecks: () =>
    Effect.succeed({
      _tag: "succeeded",
      createdAt: new Date(0),
      headSha: "head",
      headPushedAt: new Date(0),
      isDraft: false,
    }),
  resolvePrMergeConflict: () => Effect.succeed({ _tag: "processed" }),
  investigatePrStatusChecks: () =>
    Effect.succeed({ _tag: "processed", handledCheckIds: [] }),
  markPrReadyForReview: () => Effect.void,
  decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
  mergePr: () => Effect.succeed({ _tag: "merged" }),
  closeIssue: () => Effect.void,
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
}

const statusUnavailable = (): AgentBackendStatus => ({
  selectedBackend: { id: "opencode", label: "OpenCode" },
  activeBackend: { id: "opencode", label: "OpenCode" },
  kind: "unavailable",
  reason: "opencode binary not found",
  models: [],
})

const statusRestart = (): AgentBackendStatus => ({
  selectedBackend: { id: "opencode", label: "OpenCode" },
  activeBackend: { id: "opencode", label: "OpenCode" },
  kind: "restart_required",
  reason: "Restart required",
  models: [],
})

describe("Agent Backend readiness gates", () => {
  it("rejects Implement Now while unavailable", async () => {
    const layer = WorkItemLifecycleLive.pipe(
      Layer.provideMerge(
        stubActiveAgentBackendLayer({
          getStatus: Effect.succeed(statusUnavailable()),
          requireAgentTurnsAllowed: Effect.fail(
            new AgentBackendUnavailableError({
              message: "opencode binary not found",
              reason: "opencode binary not found",
            }),
          ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(successfulSteps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* db.storeIssue({
          repositoryId: repo.id,
          githubIssueNumber: 1,
          title: "Issue",
          body: "body",
          url: "https://github.com/acme/widgets/issues/1",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const error = yield* Effect.flip(lifecycle.implementNow(repo.id, 1))
        expect(error).toBeInstanceOf(LifecycleUnavailableError)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("rejects Implement Now while restart is required", async () => {
    const layer = WorkItemLifecycleLive.pipe(
      Layer.provideMerge(
        stubActiveAgentBackendLayer({
          getStatus: Effect.succeed(statusRestart()),
          requireAgentTurnsAllowed: Effect.fail(
            new AgentBackendRestartRequiredError({
              message: "Restart required",
              selectedBackendId: "opencode",
              activeBackendId: "opencode",
            }),
          ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(successfulSteps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* db.storeIssue({
          repositoryId: repo.id,
          githubIssueNumber: 1,
          title: "Issue",
          body: "body",
          url: "https://github.com/acme/widgets/issues/1",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        const error = yield* Effect.flip(lifecycle.implementNow(repo.id, 1))
        expect(error).toBeInstanceOf(LifecycleRestartRequiredError)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("allows Agent-free create_worktree while backend is unavailable", async () => {
    const layer = WorkItemLifecycleLive.pipe(
      Layer.provideMerge(
        Layer.succeed(
          ActiveAgentBackend,
          ActiveAgentBackend.of({
            getStatus: Effect.succeed(statusUnavailable()),
            recheck: () => Effect.succeed(statusUnavailable()),
            requireAgentTurnsAllowed: Effect.void,
            setSelectedBackend: () => Effect.succeed(statusUnavailable()),
            getActiveRegistration: Effect.succeed({
              descriptor: { id: "opencode", label: "OpenCode" },
              capabilities: [
                { _tag: "SessionTelemetry", supported: true },
                { _tag: "KeymaxxerMcp", supported: true },
              ],
            }),
            getSessionTelemetry: () => Effect.die("unused"),
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(successfulSteps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* db.storeIssue({
          repositoryId: repo.id,
          githubIssueNumber: 1,
          title: "Issue",
          body: "body",
          url: "https://github.com/acme/widgets/issues/1",
          state: "OPEN",
          githubCreatedAt: new Date(),
          issueAuthor: null,
          parent: null,
          parentPosition: null,
          hasChildren: false,
          blockedBy: [],
        })
        // Force-ready require so create succeeds, then run agent-free step.
        const created = yield* lifecycle.implementNow(repo.id, 1)
        expect(created.agentBackend).toBe("opencode")
        const stepRunId = created.stepRuns[0]?.id
        expect(stepRunId).toBeDefined()
        const result = yield* lifecycle.runStep(stepRunId!)
        expect(result._tag).toBe("processed")
        if (result._tag === "processed") {
          expect(result.workItem.state).toBe("install_dependencies")
          const installRun = result.workItem.stepRuns.find(
            (run) => run.step === "install_dependencies",
          )
          expect(installRun?.status).toBe("queued")
        }
        // Agent-dependent install must fail without starting handler success.
        const installId = (
          result._tag === "processed"
            ? result.workItem.stepRuns.find(
                (run) => run.step === "install_dependencies",
              )?.id
            : undefined
        )!
        const blocked = yield* lifecycle.runStep(installId)
        expect(blocked._tag).toBe("processed")
        if (blocked._tag === "processed") {
          const failed = blocked.workItem.stepRuns.find(
            (run) => run.id === installId,
          )
          expect(failed?.status).toBe("failed")
          expect(failed?.reasonCode).toBe(
            STEP_RUN_REASON.agentBackendUnavailable,
          )
        }
      }).pipe(Effect.provide(layer)),
    )
  })
})
