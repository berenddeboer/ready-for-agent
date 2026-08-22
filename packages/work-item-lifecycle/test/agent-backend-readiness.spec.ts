import { Effect, Layer } from "effect"
import { systemError } from "effect/PlatformError"
import {
  ActiveAgentBackend,
  AgentBackendNotInstalledError,
  type AgentBackendRuntimeStatus,
  type AgentBackendStatus,
  AgentBackendUnavailableError,
  formatAgentCliNotFoundRemediation,
  toAgentBackendStatus,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  ImplementOpenCodeError,
  LifecycleSteps,
  type LifecycleStepsShape,
  AgentBackendUnavailableError as LifecycleUnavailableError,
  STEP_RUN_REASON,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
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
  commit: () =>
    Effect.succeed({
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: "Why\n\nCloses #1",
    }),
  createPr: () =>
    Effect.succeed({
      pullRequestNumber: 101,
      completion: "native" as const,
      publicationTitle: "feat: test",
      publicationBody: "Why\n\nCloses #1",
    }),
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
  markPrReadyForReview: () => Effect.succeed({ completion: "native" as const }),
  decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
  mergePr: () => Effect.succeed({ _tag: "merged" }),
  closeIssue: () => Effect.void,
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
}

const runtimeUnavailable = (): AgentBackendRuntimeStatus => ({
  backend: { id: "opencode", label: "OpenCode" },
  kind: "unavailable",
  reason: "opencode binary not found",
  models: [],
  provider: null,
  warnings: [],
})

const statusUnavailable = (): AgentBackendStatus =>
  toAgentBackendStatus(runtimeUnavailable())

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
      Layer.provideMerge(stubGitHubServiceLayer()),
      Layer.provideMerge(stubGitLabServiceLayer()),
      Layer.provideMerge(stubAzureDevOpsServiceLayer()),
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
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
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
          issueNumber: 1,
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

  it("allows Agent-free create_worktree while backend is unavailable", async () => {
    const layer = WorkItemLifecycleLive.pipe(
      Layer.provideMerge(
        Layer.succeed(
          ActiveAgentBackend,
          ActiveAgentBackend.of({
            listStatuses: Effect.succeed([runtimeUnavailable()]),
            getBackendStatus: () => Effect.succeed(runtimeUnavailable()),
            getStatus: Effect.succeed(statusUnavailable()),
            setSelectedOrInUse: () => Effect.succeed([runtimeUnavailable()]),
            recheck: () => Effect.succeed(runtimeUnavailable()),
            requireAgentTurnsAllowed: () => Effect.void,
            activate: () => Effect.succeed(runtimeUnavailable()),
            drop: () => Effect.void,
            preview: () =>
              Effect.succeed({
                backend: { id: "opencode", label: "OpenCode" },
                kind: "unavailable" as const,
                reason: "opencode binary not found",
                models: [],
                provider: null,
                warnings: [],
              }),
            withConfigCoordination: (effect) => effect,
            getRegistration: () =>
              Effect.succeed({
                descriptor: { id: "opencode", label: "OpenCode" },
                capabilities: [
                  { _tag: "SessionTelemetry", supported: true },
                  { _tag: "KeymaxxerMcp", supported: true },
                ],
              }),
            getActiveRegistration: Effect.succeed({
              descriptor: { id: "opencode", label: "OpenCode" },
              capabilities: [
                { _tag: "SessionTelemetry", supported: true },
                { _tag: "KeymaxxerMcp", supported: true },
              ],
            }),
            startTurn: () => Effect.die("unused"),
            continueTurn: () => Effect.die("unused"),
            inspectBackend: () => Effect.die("unused"),
            getSessionTelemetry: () => Effect.die("unused"),
            getAgentTurnTail: () => Effect.die("unused"),
          }),
        ),
      ),
      Layer.provideMerge(stubGitHubServiceLayer()),
      Layer.provideMerge(stubGitLabServiceLayer()),
      Layer.provideMerge(stubAzureDevOpsServiceLayer()),
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
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
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
          issueNumber: 1,
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

const OPENCODE_BACKEND = { id: "opencode" as const, label: "OpenCode" }
const OPENCODE_REMEDIATION = formatAgentCliNotFoundRemediation({
  backendLabel: "OpenCode",
  binary: "opencode",
})

const notInstalledError = () =>
  new AgentBackendNotInstalledError({
    message: OPENCODE_REMEDIATION,
    backend: OPENCODE_BACKEND,
    binary: "opencode",
    cause: systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      cause: Object.assign(
        new Error('Executable not found in $PATH: "opencode"'),
        { code: "ENOENT" },
      ),
    }),
  })

const nonEnoentPlatformError = systemError({
  _tag: "Busy",
  module: "ChildProcess",
  method: "spawn",
  cause: Object.assign(new Error("resource temporarily unavailable"), {
    code: "EAGAIN",
  }),
})

const readyRuntime = (): AgentBackendRuntimeStatus => ({
  backend: OPENCODE_BACKEND,
  kind: "ready",
  reason: null,
  models: [],
  provider: null,
  warnings: [],
})

const cachedReadyBackendLayer = (options: {
  readonly afterRecheck: AgentBackendRuntimeStatus
}) => {
  let status = readyRuntime()
  const opencodeRegistration = {
    descriptor: OPENCODE_BACKEND,
    capabilities: [
      { _tag: "SessionTelemetry" as const, supported: true },
      { _tag: "KeymaxxerMcp" as const, supported: true },
    ],
  }
  return Layer.succeed(
    ActiveAgentBackend,
    ActiveAgentBackend.of({
      listStatuses: Effect.sync(() => [status]),
      getBackendStatus: () => Effect.sync(() => status),
      getStatus: Effect.sync(() => toAgentBackendStatus(status)),
      setSelectedOrInUse: () => Effect.sync(() => [status]),
      recheck: () =>
        Effect.sync(() => {
          status = options.afterRecheck
          return status
        }),
      requireAgentTurnsAllowed: () => Effect.void,
      activate: () => Effect.sync(() => status),
      drop: () => Effect.void,
      preview: () => Effect.sync(() => status),
      withConfigCoordination: (effect) => effect,
      getRegistration: () => Effect.succeed(opencodeRegistration),
      getActiveRegistration: Effect.succeed(opencodeRegistration),
      startTurn: () => Effect.die("unused"),
      continueTurn: () => Effect.die("unused"),
      inspectBackend: () => Effect.die("unused"),
      getSessionTelemetry: () => Effect.die("unused"),
      getAgentTurnTail: () => Effect.die("unused"),
    }),
  )
}

const readinessLifecycleLayer = (
  active: Layer.Layer<ActiveAgentBackend>,
  steps: LifecycleStepsShape,
) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(active),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

const seedReadyWorkItem = Effect.gen(function* () {
  const db = yield* DbService
  const lifecycle = yield* WorkItemLifecycle
  const repo = yield* db.addRepository({
    forge: "github",
    forgeHost: "github.com",
    projectPath: "acme/widgets",
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
    issueNumber: 1,
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
  const created = yield* lifecycle.implementNow(repo.id, 1)
  const createRun = created.stepRuns[0]
  if (createRun === undefined) {
    throw new Error("expected create_worktree Step Run")
  }
  const afterCreate = yield* lifecycle.runStep(createRun.id)
  if (afterCreate._tag !== "processed") {
    throw new Error("expected create_worktree to process")
  }
  const installRun = afterCreate.workItem.stepRuns.find(
    (run) => run.step === "install_dependencies",
  )
  if (installRun === undefined) {
    throw new Error("expected install_dependencies Step Run")
  }
  const afterInstall = yield* lifecycle.runStep(installRun.id)
  if (afterInstall._tag !== "processed") {
    throw new Error("expected install_dependencies to process")
  }
  const implementRun = afterInstall.workItem.stepRuns.find(
    (run) => run.step === "implement",
  )
  if (implementRun === undefined) {
    throw new Error("expected implement Step Run")
  }
  return { implementRunId: implementRun.id }
})

describe("Agent Backend spawn not-found classification", () => {
  it("classifies a wrapped spawn ENOENT as agent_backend_unavailable and rechecks", async () => {
    const unavailableAfterRecheck: AgentBackendRuntimeStatus = {
      backend: OPENCODE_BACKEND,
      kind: "unavailable",
      reason: OPENCODE_REMEDIATION,
      models: [],
      provider: null,
      warnings: [],
    }
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () =>
        Effect.fail(
          new ImplementOpenCodeError({
            message: "OpenCode failed to implement the Work Item issue",
            worktreePath: "/tmp/worktrees/acme-widgets-42",
            cause: notInstalledError(),
          }),
        ),
    }
    const layer = readinessLifecycleLayer(
      cachedReadyBackendLayer({ afterRecheck: unavailableAfterRecheck }),
      steps,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const seeded = yield* seedReadyWorkItem
        const result = yield* lifecycle.runStep(seeded.implementRunId)
        expect(result._tag).toBe("processed")
        if (result._tag !== "processed") {
          return
        }
        expect(result.workItem.state).toBe("implement")
        const failed = result.workItem.stepRuns.find(
          (run) => run.id === seeded.implementRunId,
        )
        expect(failed?.status).toBe("failed")
        expect(failed?.reasonCode).toBe(STEP_RUN_REASON.agentBackendUnavailable)
        expect(failed?.reasonMessage).toBe(OPENCODE_REMEDIATION)
        const active = yield* ActiveAgentBackend
        const status = yield* active.getBackendStatus("opencode")
        expect(status?.kind).toBe("unavailable")
        expect(status?.reason).toBe(OPENCODE_REMEDIATION)
      }).pipe(Effect.provide(layer)),
    )
  })

  it("keeps a non-ENOENT PlatformError as handler_failed and does not recheck", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () =>
        Effect.fail(
          new ImplementOpenCodeError({
            message: "OpenCode failed to implement the Work Item issue",
            worktreePath: "/tmp/worktrees/acme-widgets-42",
            cause: nonEnoentPlatformError,
          }),
        ),
    }
    const layer = readinessLifecycleLayer(
      cachedReadyBackendLayer({
        afterRecheck: {
          backend: OPENCODE_BACKEND,
          kind: "unavailable",
          reason: "should not flip",
          models: [],
          provider: null,
          warnings: [],
        },
      }),
      steps,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const seeded = yield* seedReadyWorkItem
        const result = yield* lifecycle.runStep(seeded.implementRunId)
        expect(result._tag).toBe("processed")
        if (result._tag !== "processed") {
          return
        }
        expect(result.workItem.state).toBe("implement")
        const failed = result.workItem.stepRuns.find(
          (run) => run.id === seeded.implementRunId,
        )
        expect(failed?.status).toBe("failed")
        expect(failed?.reasonCode).toBe(STEP_RUN_REASON.handlerFailed)
        expect(failed?.reasonMessage).toBe(
          "OpenCode failed to implement the Work Item issue",
        )
        const active = yield* ActiveAgentBackend
        const status = yield* active.getBackendStatus("opencode")
        expect(status?.kind).toBe("ready")
      }).pipe(Effect.provide(layer)),
    )
  })
})
