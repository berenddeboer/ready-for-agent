import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  getBuiltInAgentBackend,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  DbService,
  DbServiceLive,
  type DbServiceShape,
} from "@ready-for-agent/db-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  InstallCommandError,
  InvalidExecutionProfileError,
  type LifecycleStepContext,
  LifecycleSteps,
  type LifecycleStepsShape,
  AgentBackendUnavailableError as LifecycleUnavailableError,
  STEP_RUN_REASON,
  UnfinishedWorkItemExistsError,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const opencodeRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.opencode)!
const grokRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.grok)!

const catalog = [
  { id: "build-model", thinkingLevels: ["low", "high"] },
  { id: "review-model", thinkingLevels: ["max"] },
]

const sameAsBuildProfile = {
  agentBackendId: "opencode",
  buildModel: "build-model",
  buildThinkingLevel: "high",
  reviewSameAsBuild: true,
  reviewModel: null,
  reviewThinkingLevel: null,
}

const explicitReviewProfile = {
  ...sameAsBuildProfile,
  reviewSameAsBuild: false,
  reviewModel: "review-model",
  reviewThinkingLevel: "max",
}

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
  markPrReadyForReview: () => Effect.void,
  decidePrMerge: () => Effect.succeed({ _tag: "clanker_merge" }),
  mergePr: () => Effect.succeed({ _tag: "merged" }),
  closeIssue: () => Effect.void,
  localCleanup: () => Effect.void,
  removeWorktree: () => Effect.void,
}

const recordingSteps = (
  calls: Array<{
    readonly step: string
    readonly model: string
    readonly thinkingLevel: string | null
    readonly reviewModel: string
    readonly reviewThinkingLevel: string | null
  }>,
): LifecycleStepsShape => ({
  ...successfulSteps,
  implement: (context: LifecycleStepContext) =>
    Effect.sync(() => {
      calls.push({
        step: "implement",
        model: context.model,
        thinkingLevel: context.thinkingLevel,
        reviewModel: context.reviewModel,
        reviewThinkingLevel: context.reviewThinkingLevel,
      })
      return "ses_test"
    }),
  review: (context: LifecycleStepContext) =>
    Effect.sync(() => {
      calls.push({
        step: "review",
        model: context.model,
        thinkingLevel: context.thinkingLevel,
        reviewModel: context.reviewModel,
        reviewThinkingLevel: context.reviewThinkingLevel,
      })
      return { _tag: "clean" as const }
    }),
})

const storeOpenLeafIssue = (
  db: Pick<DbServiceShape, "storeIssue">,
  repositoryId: string,
  issueNumber: number,
) =>
  db.storeIssue({
    repositoryId,
    issueNumber,
    title: `Issue ${issueNumber}`,
    body: "body",
    url: `https://github.com/acme/widgets/issues/${issueNumber}`,
    state: "OPEN",
    githubCreatedAt: new Date(),
    issueAuthor: null,
    parent: null,
    parentPosition: null,
    hasChildren: false,
    blockedBy: [],
  })

const seedHarness = (
  db: Pick<DbServiceShape, "updateConfig">,
  input: {
    readonly selectedAgentBackend: string
    readonly defaultModel: string | null
  },
) =>
  db.updateConfig({
    selectedAgentBackend: input.selectedAgentBackend,
    defaultModel: input.defaultModel,
    defaultThinkingLevel: null,
    reviewModel: null,
    reviewThinkingLevel: null,
    maxConcurrentAgentTurns: 2,
    maxConcurrentWorkItems: 5,
  })

const lifecycleLayer = (
  active: Layer.Layer<ActiveAgentBackend>,
  steps: LifecycleStepsShape = successfulSteps,
) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(active),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

const catalogLayer = (models = catalog) =>
  stubActiveAgentBackendLayer({
    registration: opencodeRegistration,
    registrations: [grokRegistration],
    models,
  })

const advanceToQueued = (
  lifecycle: WorkItemLifecycle,
  stepRunId: string,
  nextStep: string,
) =>
  Effect.gen(function* () {
    const result = yield* lifecycle.runStep(stepRunId)
    expect(result._tag).toBe("processed")
    if (result._tag !== "processed") {
      return undefined
    }
    return result.workItem.stepRuns.find(
      (run) => run.step === nextStep && run.status === "queued",
    )
  })

describe("implementWith", () => {
  it("creates a Work Item with a durable complete explicit profile", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-implement-with.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 1)
        const created = yield* lifecycle.implementWith(
          repo.id,
          1,
          explicitReviewProfile,
        )
        expect(created.agentBackend).toBe("opencode")
        expect(created.executionProfile).toEqual({
          agentBackend: "opencode",
          build: { model: "build-model", thinkingLevel: "high" },
          review: {
            kind: "explicit",
            model: "review-model",
            thinkingLevel: "max",
          },
        })
        const reloaded = yield* lifecycle.getWorkItem(created.id)
        expect(reloaded.executionProfile).toEqual(created.executionProfile)
      }).pipe(Effect.provide(lifecycleLayer(catalogLayer()))),
    )
  })

  it("persists Same as build as intent and resolves it to the build selection", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-same-as-build.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 2)
        const created = yield* lifecycle.implementWith(
          repo.id,
          2,
          sameAsBuildProfile,
        )
        expect(created.executionProfile).toEqual({
          agentBackend: "opencode",
          build: { model: "build-model", thinkingLevel: "high" },
          review: { kind: "same_as_build" },
        })
      }).pipe(Effect.provide(lifecycleLayer(catalogLayer()))),
    )
  })

  it("does not create a Work Item when the profile is partial", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-partial.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 3)
        const error = yield* Effect.flip(
          lifecycle.implementWith(repo.id, 3, {
            ...explicitReviewProfile,
            reviewModel: null,
          }),
        )
        expect(error).toBeInstanceOf(InvalidExecutionProfileError)
        const items = yield* lifecycle.listWorkItemsForIssue(repo.id, 3)
        expect(items).toEqual([])
      }).pipe(Effect.provide(lifecycleLayer(catalogLayer()))),
    )
  })

  it("does not create a Work Item when the catalog is empty", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-empty-catalog.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 4)
        const error = yield* Effect.flip(
          lifecycle.implementWith(repo.id, 4, sameAsBuildProfile),
        )
        expect(error).toBeInstanceOf(InvalidExecutionProfileError)
        expect(error.message).toContain("non-empty Agent Model catalog")
        expect(yield* lifecycle.listWorkItemsForIssue(repo.id, 4)).toEqual([])
      }).pipe(Effect.provide(lifecycleLayer(catalogLayer([])))),
    )
  })

  it("activates an inactive shipped backend and keeps it captured without changing saved defaults", async () => {
    const active = stubActiveAgentBackendLayer({
      registration: opencodeRegistration,
      models: catalog,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const backends = yield* ActiveAgentBackend
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-inactive.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 5)
        expect(
          yield* backends.getBackendStatus(AGENT_BACKEND_IDS.grok),
        ).toBeNull()
        const created = yield* lifecycle.implementWith(repo.id, 5, {
          ...sameAsBuildProfile,
          agentBackendId: "grok",
        })
        expect(created.agentBackend).toBe("grok")
        expect(created.executionProfile).toEqual({
          agentBackend: "grok",
          build: { model: "build-model", thinkingLevel: "high" },
          review: { kind: "same_as_build" },
        })
        expect(yield* db.getConfig).toMatchObject({
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        expect((yield* db.listRepositories)[0]?.selectedAgentBackend).toBeNull()
        expect(yield* db.listSelectedOrInUseBackendIds).toEqual([
          "opencode",
          "grok",
        ])
        expect(
          yield* backends.getBackendStatus(AGENT_BACKEND_IDS.grok),
        ).not.toBeNull()
      }).pipe(Effect.provide(lifecycleLayer(active))),
    )
  })

  it("creates no Work Item and leaves defaults unchanged when activation inspect fails", async () => {
    const active = stubActiveAgentBackendLayer({
      registration: opencodeRegistration,
      models: catalog,
      newlyActivatedKind: "unavailable",
      newlyActivatedReason: "Grok Build CLI is not installed",
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const backends = yield* ActiveAgentBackend
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-activate-fail.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 15)
        const error = yield* Effect.flip(
          lifecycle.implementWith(repo.id, 15, {
            ...sameAsBuildProfile,
            agentBackendId: "grok",
          }),
        )
        expect(error).toBeInstanceOf(LifecycleUnavailableError)
        expect(error.message).toContain("Grok Build CLI is not installed")
        expect(yield* lifecycle.listWorkItemsForIssue(repo.id, 15)).toEqual([])
        expect(yield* db.getConfig).toMatchObject({
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        expect((yield* db.listRepositories)[0]?.selectedAgentBackend).toBeNull()
        expect(yield* db.listSelectedOrInUseBackendIds).toEqual(["opencode"])
        expect(
          yield* backends.getBackendStatus(AGENT_BACKEND_IDS.grok),
        ).toBeNull()
      }).pipe(Effect.provide(lifecycleLayer(active))),
    )
  })

  it("leaves Implement Now settings-resolved and without a profile", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-ordinary.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "build-model",
        })
        yield* storeOpenLeafIssue(db, repo.id, 6)
        const created = yield* lifecycle.implementNow(repo.id, 6)
        expect(created.executionProfile).toBeNull()
        expect(created.agentBackend).toBe("opencode")
      }).pipe(Effect.provide(lifecycleLayer(catalogLayer()))),
    )
  })

  it("rejects a second unfinished Work Item without creating another row", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-unique.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 7)
        const first = yield* lifecycle.implementWith(
          repo.id,
          7,
          sameAsBuildProfile,
        )
        const error = yield* Effect.flip(
          lifecycle.implementWith(repo.id, 7, explicitReviewProfile),
        )
        expect(error).toBeInstanceOf(UnfinishedWorkItemExistsError)
        const items = yield* lifecycle.listWorkItemsForIssue(repo.id, 7)
        expect(items.map((item) => item.id)).toEqual([first.id])
      }).pipe(Effect.provide(lifecycleLayer(catalogLayer()))),
    )
  })

  it("routes Agent Turns through the captured backend after activating it", async () => {
    const backends: string[] = []
    const recording: LifecycleStepsShape = {
      ...successfulSteps,
      implement: (context: LifecycleStepContext) =>
        Effect.sync(() => {
          backends.push(context.agentBackend)
          return "ses_test"
        }),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-route-grok.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 16)
        const created = yield* lifecycle.implementWith(repo.id, 16, {
          ...sameAsBuildProfile,
          agentBackendId: "grok",
        })
        expect(created.agentBackend).toBe("grok")
        const afterCreate = yield* advanceToQueued(
          lifecycle,
          created.stepRuns[0]!.id,
          "install_dependencies",
        )
        const afterInstall = yield* advanceToQueued(
          lifecycle,
          afterCreate!.id,
          "implement",
        )
        yield* lifecycle.runStep(afterInstall!.id)
        expect(backends).toEqual(["grok"])
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              models: catalog,
            }),
            recording,
          ),
        ),
      ),
    )
  })

  it("uses explicit build and review selections on Agent Turns and ignores later settings", async () => {
    const calls: Array<{
      readonly step: string
      readonly model: string
      readonly thinkingLevel: string | null
      readonly reviewModel: string
      readonly reviewThinkingLevel: string | null
    }> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-turns.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 8)
        const created = yield* lifecycle.implementWith(
          repo.id,
          8,
          explicitReviewProfile,
        )
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-after-create",
        })
        const afterCreate = yield* advanceToQueued(
          lifecycle,
          created.stepRuns[0]!.id,
          "install_dependencies",
        )
        const afterInstall = yield* advanceToQueued(
          lifecycle,
          afterCreate!.id,
          "implement",
        )
        const afterImplement = yield* advanceToQueued(
          lifecycle,
          afterInstall!.id,
          "assess_changes",
        )
        const afterAssess = yield* advanceToQueued(
          lifecycle,
          afterImplement!.id,
          "pre_commit",
        )
        const afterPreCommit = yield* advanceToQueued(
          lifecycle,
          afterAssess!.id,
          "review",
        )
        yield* lifecycle.runStep(afterPreCommit!.id)
        expect(calls).toEqual([
          {
            step: "implement",
            model: "build-model",
            thinkingLevel: "high",
            reviewModel: "review-model",
            reviewThinkingLevel: "max",
          },
          {
            step: "review",
            model: "build-model",
            thinkingLevel: "high",
            reviewModel: "review-model",
            reviewThinkingLevel: "max",
          },
        ])
      }).pipe(
        Effect.provide(lifecycleLayer(catalogLayer(), recordingSteps(calls))),
      ),
    )
  })

  it("retains the explicit profile through Pause, Start, and Retry", async () => {
    const failingInstall: LifecycleStepsShape = {
      ...successfulSteps,
      installDependencies: () =>
        Effect.fail(
          new InstallCommandError({
            message: "install failed",
            command: "bun",
            args: ["install"],
            cwd: "/tmp",
            exitCode: 1,
            stderr: "failed",
          }),
        ),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-retry.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 9)
        const created = yield* lifecycle.implementWith(
          repo.id,
          9,
          sameAsBuildProfile,
        )
        const paused = yield* lifecycle.pause(created.id)
        expect(paused.executionProfile).toEqual({
          agentBackend: "opencode",
          build: { model: "build-model", thinkingLevel: "high" },
          review: { kind: "same_as_build" },
        })
        const started = yield* lifecycle.start(paused.id)
        expect(started.executionProfile).toEqual(paused.executionProfile)
        const queuedCreate = started.stepRuns.find(
          (run) => run.step === "create_worktree" && run.status === "queued",
        )
        expect(queuedCreate).toBeDefined()
        const afterCreate = yield* advanceToQueued(
          lifecycle,
          queuedCreate!.id,
          "install_dependencies",
        )
        const afterFail = yield* lifecycle.runStep(afterCreate!.id)
        expect(afterFail._tag).toBe("processed")
        const retried = yield* lifecycle.retry(created.id)
        expect(retried.executionProfile).toEqual(paused.executionProfile)
      }).pipe(Effect.provide(lifecycleLayer(catalogLayer(), failingInstall))),
    )
  })

  it("fails closed on catalog drift before spawning an Agent Turn", async () => {
    const calls: Array<{
      readonly step: string
      readonly model: string
      readonly thinkingLevel: string | null
      readonly reviewModel: string
      readonly reviewThinkingLevel: string | null
    }> = []
    const liveCatalog = [...catalog]
    const mutableLayer = stubActiveAgentBackendLayer({
      registration: opencodeRegistration,
      models: liveCatalog,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-drift.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "settings-build",
        })
        yield* storeOpenLeafIssue(db, repo.id, 10)
        const created = yield* lifecycle.implementWith(
          repo.id,
          10,
          sameAsBuildProfile,
        )
        liveCatalog.splice(0, liveCatalog.length, {
          id: "other-model",
          thinkingLevels: ["low"],
        })
        const afterCreate = yield* advanceToQueued(
          lifecycle,
          created.stepRuns[0]!.id,
          "install_dependencies",
        )
        const result = yield* lifecycle.runStep(afterCreate!.id)
        expect(result._tag).toBe("processed")
        if (result._tag !== "processed") return
        const failed = result.workItem.stepRuns.find(
          (run) => run.id === afterCreate!.id,
        )
        expect(failed?.status).toBe("failed")
        expect(failed?.reasonCode).toBe(STEP_RUN_REASON.agentModelNotInCatalog)
        expect(failed?.reasonMessage).toContain(
          "cannot substitute another model",
        )
        expect(calls).toEqual([])
      }).pipe(
        Effect.provide(lifecycleLayer(mutableLayer, recordingSteps(calls))),
      ),
    )
  })

  it("keeps waiting Work Items on their explicit profile", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-wait.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "build-model",
        })
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "build-model",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 1,
        })
        yield* storeOpenLeafIssue(db, repo.id, 11)
        yield* storeOpenLeafIssue(db, repo.id, 12)
        const first = yield* lifecycle.implementNow(repo.id, 11)
        expect(first.waitingSince).toBeNull()
        const waiter = yield* lifecycle.implementWith(
          repo.id,
          12,
          sameAsBuildProfile,
        )
        expect(waiter.waitingSince).not.toBeNull()
        expect(waiter.executionProfile).toEqual({
          agentBackend: "opencode",
          build: { model: "build-model", thinkingLevel: "high" },
          review: { kind: "same_as_build" },
        })
      }).pipe(Effect.provide(lifecycleLayer(catalogLayer()))),
    )
  })
})
