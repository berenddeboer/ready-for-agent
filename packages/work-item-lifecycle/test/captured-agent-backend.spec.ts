import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  AGENT_BACKEND_IDS,
  ActiveAgentBackend,
  AgentBackend,
  type AgentBackendId,
  AgentBackendUnavailableError,
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
  BuildModelNotConfiguredError,
  CurrentCapturedAgentBackendId,
  LifecycleSteps,
  type LifecycleStepsShape,
  AgentBackendUnavailableError as LifecycleUnavailableError,
  STEP_RUN_REASON,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  resolveAgentModelSelection,
  resolveAgentModelsForBackend,
  stubActiveAgentBackendLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const opencodeRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.opencode)!
const grokRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.grok)!

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
  commit: () => Effect.succeed({ completion: "native" as const }),
  createPr: () =>
    Effect.succeed({ pullRequestNumber: 101, completion: "native" as const }),
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

const storeOpenLeafIssue = (
  db: Pick<DbServiceShape, "storeIssue">,
  repositoryId: string,
  githubIssueNumber: number,
) =>
  db.storeIssue({
    repositoryId,
    githubIssueNumber,
    title: `Issue ${githubIssueNumber}`,
    body: "body",
    url: `https://github.com/acme/widgets/issues/${githubIssueNumber}`,
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
    defaultThinkingLevel: input.defaultModel === null ? null : "low",
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
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

describe("Captured Agent Backend (create + route + models)", () => {
  it("captures harness default when the Repository inherits", async () => {
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
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
        })
        yield* storeOpenLeafIssue(db, repo.id, 1)
        const created = yield* lifecycle.implementNow(repo.id, 1)
        expect(created.agentBackend).toBe("opencode")
        expect(repo.selectedAgentBackend).toBeNull()
      }).pipe(Effect.provide(lifecycleLayer(stubActiveAgentBackendLayer()))),
    )
  })

  it("captures the Repository override rather than the harness default", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/repos/acme/widgets-override.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
        })
        yield* db.updateRepositorySettings({
          repositoryId: repo.id,
          paused: true,
          selectedAgentBackend: "grok",
          defaultModel: "grok-code-fast-1",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          autoMerge: false,
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
        })
        yield* storeOpenLeafIssue(db, repo.id, 2)
        const created = yield* lifecycle.implementNow(repo.id, 2)
        expect(created.agentBackend).toBe("grok")
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              registrations: [grokRegistration],
            }),
          ),
        ),
      ),
    )
  })

  it("provides the captured backend id to Step Run handlers (routing ambient)", async () => {
    let ambientDuringImplement: string | null = "unset"
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () =>
        Effect.gen(function* () {
          ambientDuringImplement = yield* CurrentCapturedAgentBackendId
          return "ses_routed"
        }),
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/repos/acme/widgets-route.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
        })
        yield* db.updateRepositorySettings({
          repositoryId: repo.id,
          paused: true,
          selectedAgentBackend: "grok",
          defaultModel: "grok-code-fast-1",
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          autoMerge: false,
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
        })
        yield* storeOpenLeafIssue(db, repo.id, 3)
        const created = yield* lifecycle.implementNow(repo.id, 3)
        expect(created.agentBackend).toBe("grok")

        const createRun = created.stepRuns[0]
        expect(createRun?.step).toBe("create_worktree")
        const afterCreate = yield* lifecycle.runStep(createRun!.id)
        expect(afterCreate._tag).toBe("processed")
        if (afterCreate._tag !== "processed") {
          return
        }
        const installRun = afterCreate.workItem.stepRuns.find(
          (run) => run.step === "install_dependencies",
        )
        expect(installRun?.status).toBe("queued")
        const afterInstall = yield* lifecycle.runStep(installRun!.id)
        expect(afterInstall._tag).toBe("processed")
        if (afterInstall._tag !== "processed") {
          return
        }
        const implementRun = afterInstall.workItem.stepRuns.find(
          (run) => run.step === "implement",
        )
        expect(implementRun?.status).toBe("queued")
        const afterImplement = yield* lifecycle.runStep(implementRun!.id)
        expect(afterImplement._tag).toBe("processed")
        expect(ambientDuringImplement).toBe("grok")
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              registrations: [grokRegistration],
            }),
            steps,
          ),
        ),
      ),
    )
  })

  it("fails agent-dependent readiness when captured backend is not selectable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/repos/acme/widgets-corrupt-capture.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
        })
        yield* storeOpenLeafIssue(db, repo.id, 7)
        const created = yield* lifecycle.implementNow(repo.id, 7)
        // create_worktree is agent-free and should still succeed after corrupt.
        const createRun = created.stepRuns[0]
        expect(createRun?.step).toBe("create_worktree")
        // Corrupt capture to a non-selectable id after create (simulates bad row).
        yield* sql.unsafe(
          `UPDATE work_item SET agent_backend = ? WHERE id = ?`,
          ["not-a-backend", created.id],
        )
        const afterCreate = yield* lifecycle.runStep(createRun!.id)
        expect(afterCreate._tag).toBe("processed")
        if (afterCreate._tag !== "processed") {
          return
        }
        const installRun = afterCreate.workItem.stepRuns.find(
          (run) => run.step === "install_dependencies",
        )
        expect(installRun?.status).toBe("queued")
        const afterInstall = yield* lifecycle.runStep(installRun!.id)
        expect(afterInstall._tag).toBe("processed")
        if (afterInstall._tag !== "processed") {
          return
        }
        const failed = afterInstall.workItem.stepRuns.find(
          (run) => run.id === installRun!.id,
        )
        expect(failed?.status).toBe("failed")
        expect(failed?.reasonCode).toBe(STEP_RUN_REASON.agentBackendUnavailable)
        expect(failed?.reasonMessage).toContain("not selectable")
        expect(failed?.reasonMessage).toContain("not-a-backend")
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              // Default opencode is Ready — readiness must not normalize corrupt
              // capture to this default and allow the agent-dependent step.
              registration: opencodeRegistration,
            }),
          ),
        ),
      ),
    )
  })

  it("routes Agent Turns to the captured Active adapter when two backends exist", async () => {
    const startTurnCalls: AgentBackendId[] = []
    const fallbackCalls: string[] = []
    const { AgentBackendConfigError, isSelectableAgentBackendId } =
      await import("@ready-for-agent/agent-backend")

    // Mirrors LifecycleStepsLive fail-closed routing (no silent fallback).
    const routeStartTurn = Effect.gen(function* () {
      const active = yield* ActiveAgentBackend
      const fallback = yield* AgentBackend
      const captured = yield* CurrentCapturedAgentBackendId
      if (captured === null) {
        return yield* fallback.startTurn({
          prompt: "test",
          cwd: "/tmp",
          model: "x",
          thinkingLevel: null,
        })
      }
      if (!isSelectableAgentBackendId(captured)) {
        return yield* new AgentBackendConfigError({
          message: `Work Item captured Agent Backend is not selectable: ${captured}`,
        })
      }
      return yield* active.startTurn(captured, {
        prompt: "test",
        cwd: "/tmp",
        model: "grok-code-fast-1",
        thinkingLevel: null,
      })
    })

    const activeLayer = stubActiveAgentBackendLayer({
      registration: opencodeRegistration,
      registrations: [grokRegistration],
      startTurn: (backendId) => {
        startTurnCalls.push(backendId)
        return Effect.succeed({
          sessionId: `ses_${backendId}`,
          assistantText: "",
        })
      },
    })
    const fallbackLayer = Layer.succeed(
      AgentBackend,
      AgentBackend.of({
        startTurn: () => {
          fallbackCalls.push("startTurn")
          return Effect.succeed({
            sessionId: "ses_fallback",
            assistantText: "",
          })
        },
        continueTurn: () =>
          Effect.succeed({
            sessionId: "ses_fallback",
            assistantText: "",
          }),
        inspect: () => Effect.succeed({ models: [] }),
      }),
    )

    const result = await Effect.runPromise(
      routeStartTurn.pipe(
        Effect.provideService(CurrentCapturedAgentBackendId, "grok"),
        Effect.provide(Layer.mergeAll(activeLayer, fallbackLayer)),
      ),
    )
    expect(result.sessionId).toBe("ses_grok")
    expect(startTurnCalls).toEqual(["grok"])
    expect(fallbackCalls).toEqual([])

    const invalid = await Effect.runPromise(
      Effect.flip(
        routeStartTurn.pipe(
          Effect.provideService(CurrentCapturedAgentBackendId, "not-a-backend"),
          Effect.provide(Layer.mergeAll(activeLayer, fallbackLayer)),
        ),
      ),
    )
    expect(invalid).toBeInstanceOf(AgentBackendConfigError)
    expect(fallbackCalls).toEqual([])
    expect(startTurnCalls).toEqual(["grok"])
  })

  it("resolves models from captured backend prefs, not the default flat columns", async () => {
    const dbLayer = DbServiceLive.pipe(Layer.provideMerge(DatabaseTest))
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const repo = yield* db.addRepository({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/repos/acme/widgets-models.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
        })
        // Remember grok prefs on the harness map, then return default to opencode.
        yield* db.updateConfig({
          selectedAgentBackend: "grok",
          defaultModel: "grok-code-fast-1",
          defaultThinkingLevel: "high",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
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
        // Repo overrides to grok with no local model → harness map[grok].
        yield* db.updateRepositorySettings({
          repositoryId: repo.id,
          paused: true,
          selectedAgentBackend: "grok",
          defaultModel: null,
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          autoMerge: false,
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
        })

        const config = yield* db.getConfig
        expect(config.selectedAgentBackend).toBe("opencode")
        expect(config.defaultModel).toBe("opencode/deepseek-v4-flash-free")

        // Flat harness columns would wrongly pick opencode if used as fallback.
        const wrong = resolveAgentModelSelection(
          {
            defaultModel: null,
            defaultThinkingLevel: null,
            reviewModel: null,
            reviewThinkingLevel: null,
          },
          config,
        )
        expect(wrong?.model).toBe("opencode/deepseek-v4-flash-free")

        const selection = yield* resolveAgentModelsForBackend(repo.id, "grok")
        expect(selection.model).toBe("grok-code-fast-1")
        expect(selection.thinkingLevel).toBe("high")
      }).pipe(Effect.provide(dbLayer)),
    )
  })

  it("allows create on a healthy override while the default backend is Unavailable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/repos/acme/widgets-healthy-override.git",
          isBare: true,
        })
        // Default backend has a model but is Unavailable; override is ready.
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
        })
        yield* db.updateRepositorySettings({
          repositoryId: repo.id,
          paused: true,
          selectedAgentBackend: "grok",
          defaultModel: "grok-code-fast-1",
          defaultThinkingLevel: "low",
          reviewModel: null,
          reviewThinkingLevel: null,
          autoMerge: false,
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
        })
        yield* storeOpenLeafIssue(db, repo.id, 4)
        const created = yield* lifecycle.implementNow(repo.id, 4)
        expect(created.agentBackend).toBe("grok")
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              registrations: [grokRegistration],
              requireAgentTurnsAllowedFor: (backendId) =>
                backendId === "opencode"
                  ? Effect.fail(
                      new AgentBackendUnavailableError({
                        message: "opencode binary not found",
                        reason: "opencode binary not found",
                      }),
                    )
                  : Effect.void,
            }),
          ),
        ),
      ),
    )
  })

  it("rejects create when the effective backend is Unavailable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/repos/acme/widgets-unavailable.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
        })
        yield* db.updateRepositorySettings({
          repositoryId: repo.id,
          paused: true,
          selectedAgentBackend: "grok",
          defaultModel: "grok-code-fast-1",
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          autoMerge: false,
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
        })
        yield* storeOpenLeafIssue(db, repo.id, 5)
        const error = yield* Effect.flip(lifecycle.implementNow(repo.id, 5))
        expect(error).toBeInstanceOf(LifecycleUnavailableError)
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: grokRegistration,
              requireAgentTurnsAllowed: Effect.fail(
                new AgentBackendUnavailableError({
                  message: "grok binary not found",
                  reason: "grok binary not found",
                }),
              ),
            }),
          ),
        ),
      ),
    )
  })

  it("rejects create when no build model resolves for the effective backend", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          githubOwner: "acme",
          githubRepo: "widgets",
          localPath: "/repos/acme/widgets-no-model.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
        })
        yield* db.updateRepositorySettings({
          repositoryId: repo.id,
          paused: true,
          selectedAgentBackend: "grok",
          defaultModel: null,
          defaultThinkingLevel: null,
          reviewModel: null,
          reviewThinkingLevel: null,
          autoMerge: false,
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
        })
        yield* storeOpenLeafIssue(db, repo.id, 6)
        const error = yield* Effect.flip(lifecycle.implementNow(repo.id, 6))
        expect(error).toBeInstanceOf(BuildModelNotConfiguredError)
        if (error instanceof BuildModelNotConfiguredError) {
          expect(error.message).toBe("Select a default build model first")
        }
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              registrations: [grokRegistration],
            }),
          ),
        ),
      ),
    )
  })
})
