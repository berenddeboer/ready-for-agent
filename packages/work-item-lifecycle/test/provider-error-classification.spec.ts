import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  AgentBackendExitError,
  getBuiltInAgentBackend,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { parseReasonDetail } from "@ready-for-agent/forge-contract"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  ImplementOpenCodeError,
  LifecycleSteps,
  type LifecycleStepsShape,
  STEP_RUN_REASON,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
  stubLinearServiceLayer,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const codexRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.codex)
if (codexRegistration === undefined) {
  throw new Error("Codex Agent Backend registration is missing")
}

const provider = { id: "openai", label: "OpenAI" } as const

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
      _tag: "committed" as const,
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

const lifecycleLayer = (steps: LifecycleStepsShape) =>
  WorkItemLifecycleLive.pipe(
    Layer.provideMerge(
      stubActiveAgentBackendLayer({
        registration: codexRegistration,
        provider,
      }),
    ),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
    Layer.provideMerge(stubLinearServiceLayer()),
    Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
    Layer.provideMerge(DbServiceLive),
    Layer.provideMerge(SqliteQueueServiceLive),
    Layer.provideMerge(DatabaseTest),
  )

const seedImplementRun = Effect.gen(function* () {
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
    selectedAgentBackend: "codex",
    defaultModel: "gpt-5.5",
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
  const created = yield* lifecycle.implementNow(repo.id, "1")
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

describe("Codex provider-error Step Run evidence (BER-28)", () => {
  it("persists retryable overload classification, identity, and retry timing without credentials", async () => {
    const secret = "ghp_this_must_never_appear_in_exit_message"
    const retryAt = Date.parse("2026-10-19T05:00:00.000Z")
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () =>
        Effect.fail(
          new ImplementOpenCodeError({
            message: "Codex Build failed to implement",
            worktreePath: "/tmp/worktrees/acme-widgets-42",
            cause: AgentBackendExitError.new({
              exitCode: 1,
              cwd: "/tmp/worktrees/acme-widgets-42",
              classification: "retryable_provider_error",
              providerCode: "server_overloaded",
              model: "gpt-5.5",
              retryAt,
              message: `Selected model is at capacity. Please try a different model. (${secret})`,
            }),
          }),
        ),
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const seeded = yield* seedImplementRun
        const result = yield* lifecycle.runStep(seeded.implementRunId)
        expect(result._tag).toBe("processed")
        if (result._tag !== "processed") {
          return
        }
        const failed = result.workItem.stepRuns.find(
          (run) => run.id === seeded.implementRunId,
        )
        expect(failed?.status).toBe("failed")
        expect(failed?.reasonCode).toBe(STEP_RUN_REASON.handlerFailed)
        const detail = parseReasonDetail(failed?.reasonDetail)
        expect(detail?.classification).toBe("retryable_provider_error")
        expect(detail?.providerCode).toBe("server_overloaded")
        expect(detail?.model).toBe("gpt-5.5")
        expect(detail?.provider).toEqual(provider)
        expect(detail?.retryAt).toBe("2026-10-19T05:00:00.000Z")
        expect(JSON.stringify(detail)).not.toContain(secret)
        expect(failed?.reasonMessage).not.toContain(secret)
      }).pipe(Effect.provide(lifecycleLayer(steps))),
    )
  })

  it("does not persist a retry classification for billing exhaustion or an unknown failure", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () =>
        Effect.fail(
          new ImplementOpenCodeError({
            message: "Codex Build failed to implement",
            worktreePath: "/tmp/worktrees/acme-widgets-42",
            cause: AgentBackendExitError.new({
              exitCode: 1,
              cwd: "/tmp/worktrees/acme-widgets-42",
              providerCode: "usage_limit_exceeded",
              message: "You have hit your usage limit. Try again at 5:56 PM.",
            }),
          }),
        ),
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        const seeded = yield* seedImplementRun
        const result = yield* lifecycle.runStep(seeded.implementRunId)
        expect(result._tag).toBe("processed")
        if (result._tag !== "processed") {
          return
        }
        const failed = result.workItem.stepRuns.find(
          (run) => run.id === seeded.implementRunId,
        )
        expect(failed?.reasonCode).toBe(STEP_RUN_REASON.handlerFailed)
        const detail = parseReasonDetail(failed?.reasonDetail)
        expect(detail?.classification).toBeUndefined()
        expect(detail?.retryAt).toBeUndefined()
        expect(detail?.provider).toBeUndefined()
        expect(detail?.model).toBeUndefined()
        expect(detail?.providerCode).toBe("usage_limit_exceeded")
      }).pipe(Effect.provide(lifecycleLayer(steps))),
    )
  })
})
