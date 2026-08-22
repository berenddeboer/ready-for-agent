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
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
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
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
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
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
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
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
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
          mergePolicy: "off",
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
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
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
          mergePolicy: "off",
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
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
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
    const activeLayer = stubActiveAgentBackendLayer({
      registration: opencodeRegistration,
      registrations: [grokRegistration],
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
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
          mergePolicy: "off",
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
      }).pipe(Effect.provide(Layer.mergeAll(dbLayer, activeLayer))),
    )
  })

  it("allows create on a healthy override while the default backend is Unavailable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
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
          mergePolicy: "off",
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
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
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
          mergePolicy: "off",
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
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
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
          mergePolicy: "off",
          includeAllIssueAuthors: false,
          waitForReadyForReviewChecks: true,
        })
        yield* storeOpenLeafIssue(db, repo.id, 6)
        const error = yield* Effect.flip(lifecycle.implementNow(repo.id, 6))
        expect(error).toBeInstanceOf(BuildModelNotConfiguredError)
        if (error instanceof BuildModelNotConfiguredError) {
          expect(error.message).toContain("No build model set")
          expect(error.message).toContain("acme/widgets")
          expect(error.message).toContain("Grok Build")
          expect(error.message).toContain("Settings")
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

describe("Agent Model catalog admission (issue #838)", () => {
  const STALE_BEDROCK_PROFILE = "us.anthropic.claude-sonnet-4-6"
  const opencodeCatalog = [
    { id: "opencode/deepseek-v4-flash-free", thinkingLevels: ["high"] },
    { id: "opencode/gpt-5", thinkingLevels: [] },
  ]

  /**
   * Lifecycle steps that record every invocation. Agent-dependent steps are
   * where the Agent Backend CLI would be spawned, so an empty log proves the
   * rejection happened before any Agent Turn was attempted.
   */
  const recordingSteps = (invoked: string[]): LifecycleStepsShape => ({
    ...successfulSteps,
    installDependencies: () => {
      invoked.push("install_dependencies")
      return Effect.void
    },
    implement: () => {
      invoked.push("implement")
      return Effect.succeed("ses_test")
    },
    review: () => {
      invoked.push("review")
      return Effect.succeed({ _tag: "clean" as const })
    },
  })

  it("rejects create when the resolved build model is absent from the catalog", async () => {
    const invoked: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-stale-catalog.git",
          isBare: true,
        })
        // Legacy settings left behind by a provider-mode change: the stored
        // model is a Bedrock profile the running backend does not offer.
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: STALE_BEDROCK_PROFILE,
        })
        yield* storeOpenLeafIssue(db, repo.id, 20)
        const error = yield* Effect.flip(lifecycle.implementNow(repo.id, 20))
        expect(error).toBeInstanceOf(BuildModelNotConfiguredError)
        expect(error.message).toContain(STALE_BEDROCK_PROFILE)
        expect(error.message).toContain("Agent Model catalog")
        expect(error.message).toContain("Settings")
        // No Work Item, and no Agent Backend CLI was ever reached.
        expect(yield* lifecycle.listWorkItemsForIssue(repo.id, 20)).toEqual([])
        expect(invoked).toEqual([])
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              models: opencodeCatalog,
            }),
            recordingSteps(invoked),
          ),
        ),
      ),
    )
  })

  it("rejects create when only the review model is absent from the catalog", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-stale-review.git",
          isBare: true,
        })
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/gpt-5",
          defaultThinkingLevel: null,
          reviewModel: STALE_BEDROCK_PROFILE,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* storeOpenLeafIssue(db, repo.id, 21)
        const error = yield* Effect.flip(lifecycle.implementNow(repo.id, 21))
        expect(error).toBeInstanceOf(BuildModelNotConfiguredError)
        expect(error.message).toContain("Review Agent Model")
        expect(error.message).toContain(STALE_BEDROCK_PROFILE)
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              models: opencodeCatalog,
            }),
          ),
        ),
      ),
    )
  })

  it("admits create when the resolved models are in the catalog", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-current-catalog.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
        })
        yield* storeOpenLeafIssue(db, repo.id, 22)
        const created = yield* lifecycle.implementNow(repo.id, 22)
        expect(created.agentBackend).toBe("opencode")
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              models: opencodeCatalog,
            }),
          ),
        ),
      ),
    )
  })

  it("fails an agent-dependent step whose model left the catalog, without an Agent Turn", async () => {
    const invoked: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-turn-admission.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
        })
        yield* storeOpenLeafIssue(db, repo.id, 23)
        const created = yield* lifecycle.implementNow(repo.id, 23)
        // The operator (or a legacy row) puts back a model the backend no
        // longer offers after the Work Item already exists.
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: STALE_BEDROCK_PROFILE,
        })
        const createRun = created.stepRuns[0]
        expect(createRun?.step).toBe("create_worktree")
        const afterCreate = yield* lifecycle.runStep(createRun!.id)
        expect(afterCreate._tag).toBe("processed")
        if (afterCreate._tag !== "processed") {
          return
        }
        const agentStep = afterCreate.workItem.stepRuns.find(
          (run) => run.status === "queued",
        )
        expect(agentStep).toBeDefined()
        const afterAgentStep = yield* lifecycle.runStep(agentStep!.id)
        expect(afterAgentStep._tag).toBe("processed")
        if (afterAgentStep._tag !== "processed") {
          return
        }
        const failed = afterAgentStep.workItem.stepRuns.find(
          (run) => run.id === agentStep!.id,
        )
        expect(failed?.status).toBe("failed")
        expect(failed?.reasonCode).toBe(STEP_RUN_REASON.agentModelNotInCatalog)
        expect(failed?.reasonMessage).toContain(STALE_BEDROCK_PROFILE)
        expect(failed?.reasonMessage).toContain("Settings")
        // The step never ran, so no Agent Backend CLI was spawned.
        expect(invoked).toEqual([])
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              models: opencodeCatalog,
            }),
            recordingSteps(invoked),
          ),
        ),
      ),
    )
  })

  it("rejects create when the resolved Thinking Level is not advertised", async () => {
    const invoked: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-stale-thinking.git",
          isBare: true,
        })
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "medium",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* storeOpenLeafIssue(db, repo.id, 25)
        const error = yield* Effect.flip(lifecycle.implementNow(repo.id, 25))
        expect(error).toBeInstanceOf(BuildModelNotConfiguredError)
        expect(error.message).toContain("medium")
        expect(error.message).toContain("opencode/deepseek-v4-flash-free")
        expect(error.message).toContain("Settings")
        expect(yield* lifecycle.listWorkItemsForIssue(repo.id, 25)).toEqual([])
        expect(invoked).toEqual([])
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              models: opencodeCatalog,
            }),
            recordingSteps(invoked),
          ),
        ),
      ),
    )
  })

  it("rejects create when only the review Thinking Level is not advertised", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-stale-review-thinking.git",
          isBare: true,
        })
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/gpt-5",
          defaultThinkingLevel: null,
          reviewModel: "opencode/deepseek-v4-flash-free",
          reviewThinkingLevel: "medium",
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* storeOpenLeafIssue(db, repo.id, 26)
        const error = yield* Effect.flip(lifecycle.implementNow(repo.id, 26))
        expect(error).toBeInstanceOf(BuildModelNotConfiguredError)
        expect(error.message).toContain("Review Thinking Level")
        expect(error.message).toContain("medium")
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              models: opencodeCatalog,
            }),
          ),
        ),
      ),
    )
  })

  it("admits create when the Thinking Level is advertised or null", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-valid-thinking.git",
          isBare: true,
        })
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "high",
          reviewModel: "opencode/gpt-5",
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* storeOpenLeafIssue(db, repo.id, 27)
        const created = yield* lifecycle.implementNow(repo.id, 27)
        expect(created.agentBackend).toBe("opencode")
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              models: opencodeCatalog,
            }),
          ),
        ),
      ),
    )
  })

  it("fails an agent-dependent step whose Thinking Level left the catalog, without an Agent Turn", async () => {
    const invoked: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-thinking-drift.git",
          isBare: true,
        })
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "high",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        yield* storeOpenLeafIssue(db, repo.id, 28)
        const created = yield* lifecycle.implementNow(repo.id, 28)
        yield* db.updateConfig({
          selectedAgentBackend: "opencode",
          defaultModel: "opencode/deepseek-v4-flash-free",
          defaultThinkingLevel: "medium",
          reviewModel: null,
          reviewThinkingLevel: null,
          maxConcurrentAgentTurns: 2,
          maxConcurrentWorkItems: 5,
        })
        const createRun = created.stepRuns[0]
        expect(createRun?.step).toBe("create_worktree")
        const afterCreate = yield* lifecycle.runStep(createRun!.id)
        expect(afterCreate._tag).toBe("processed")
        if (afterCreate._tag !== "processed") {
          return
        }
        const agentStep = afterCreate.workItem.stepRuns.find(
          (run) => run.status === "queued",
        )
        expect(agentStep).toBeDefined()
        const afterAgentStep = yield* lifecycle.runStep(agentStep!.id)
        expect(afterAgentStep._tag).toBe("processed")
        if (afterAgentStep._tag !== "processed") {
          return
        }
        const failed = afterAgentStep.workItem.stepRuns.find(
          (run) => run.id === agentStep!.id,
        )
        expect(failed?.status).toBe("failed")
        expect(failed?.reasonCode).toBe(
          STEP_RUN_REASON.thinkingLevelNotInCatalog,
        )
        expect(failed?.reasonMessage).toContain("medium")
        expect(failed?.reasonMessage).toContain("Settings")
        expect(invoked).toEqual([])
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
              models: opencodeCatalog,
            }),
            recordingSteps(invoked),
          ),
        ),
      ),
    )
  })

  it("does not gate on a Ready backend that reports no catalog", async () => {
    // An empty catalog carries no membership information (adapters without
    // discovery). Treating it as "everything is invalid" would stall every
    // Work Item, so admission defers to CLI-time failure.
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets-no-catalog.git",
          isBare: true,
        })
        yield* seedHarness(db, {
          selectedAgentBackend: "opencode",
          defaultModel: STALE_BEDROCK_PROFILE,
        })
        yield* storeOpenLeafIssue(db, repo.id, 24)
        const created = yield* lifecycle.implementNow(repo.id, 24)
        expect(created.agentBackend).toBe("opencode")
      }).pipe(
        Effect.provide(
          lifecycleLayer(
            stubActiveAgentBackendLayer({
              registration: opencodeRegistration,
            }),
          ),
        ),
      ),
    )
  })
})
