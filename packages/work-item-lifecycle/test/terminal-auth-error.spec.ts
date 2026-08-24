import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  AgentBackendExitError,
  CLAUDE_BEDROCK_CREDENTIAL_REMEDIATION,
  CLAUDE_FIRST_PARTY_AUTH_REMEDIATION,
  getBuiltInAgentBackend,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
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
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const claudeRegistration = getBuiltInAgentBackend(AGENT_BACKEND_IDS.claude)
if (claudeRegistration === undefined) {
  throw new Error("Claude Agent Backend registration is missing")
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
      stubActiveAgentBackendLayer({ registration: claudeRegistration }),
    ),
    Layer.provideMerge(stubGitHubServiceLayer()),
    Layer.provideMerge(stubGitLabServiceLayer()),
    Layer.provideMerge(stubAzureDevOpsServiceLayer()),
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
    selectedAgentBackend: "claude",
    defaultModel: "sonnet",
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

const wrappedExit = (message: string, classification?: "terminal_auth_error") =>
  new ImplementOpenCodeError({
    message: "Claude Code fallback failed to install dependencies",
    worktreePath: "/tmp/worktrees/acme-widgets-42",
    cause: AgentBackendExitError.new({
      exitCode: 1,
      cwd: "/tmp/worktrees/acme-widgets-42",
      message,
      ...(classification !== undefined ? { classification } : {}),
    }),
  })

describe("terminal_auth_error Step Run classification (issue #1058)", () => {
  it("records a dedicated reason and Bedrock remediation for expired AWS credentials", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE"
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () =>
        Effect.fail(
          wrappedExit(
            `ExpiredTokenException: The security token included in the request is expired (${secret})`,
          ),
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
        expect(failed?.reasonCode).toBe(
          STEP_RUN_REASON.agentBackendAuthRejected,
        )
        expect(failed?.reasonMessage).toBe(
          `Claude Code could not authenticate to Amazon Bedrock (credentials missing or expired). ${CLAUDE_BEDROCK_CREDENTIAL_REMEDIATION}`,
        )
        expect(failed?.reasonMessage).toContain("Recheck Agent Backend")
        expect(failed?.reasonMessage).not.toContain(secret)
        expect(failed?.reasonMessage?.toLowerCase()).not.toContain(
          "aws sso login",
        )
      }).pipe(Effect.provide(lifecycleLayer(steps))),
    )
  })

  it("names first-party Claude remediation when that provider is reported", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () =>
        Effect.fail(wrappedExit("ProviderAuthError", "terminal_auth_error")),
    }

    const firstPartyLayer = WorkItemLifecycleLive.pipe(
      Layer.provideMerge(
        stubActiveAgentBackendLayer({
          registration: claudeRegistration,
          provider: { id: "firstParty", label: "First-party" },
        }),
      ),
      Layer.provideMerge(stubGitHubServiceLayer()),
      Layer.provideMerge(stubGitLabServiceLayer()),
      Layer.provideMerge(stubAzureDevOpsServiceLayer()),
      Layer.provideMerge(
        Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps)),
      ),
      Layer.provideMerge(DbServiceLive),
      Layer.provideMerge(SqliteQueueServiceLive),
      Layer.provideMerge(DatabaseTest),
    )

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
        expect(failed?.reasonCode).toBe(
          STEP_RUN_REASON.agentBackendAuthRejected,
        )
        expect(failed?.reasonMessage).toContain("Claude Code")
        expect(failed?.reasonMessage).toContain(
          CLAUDE_FIRST_PARTY_AUTH_REMEDIATION,
        )
      }).pipe(Effect.provide(firstPartyLayer)),
    )
  })

  it("keeps an unrecognized turn failure on handler_failed", async () => {
    const steps: LifecycleStepsShape = {
      ...successfulSteps,
      implement: () =>
        Effect.fail(
          wrappedExit("Claude Code fallback failed to install dependencies"),
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
        expect(failed?.reasonMessage).toBe(
          "Claude Code fallback failed to install dependencies",
        )
      }).pipe(Effect.provide(lifecycleLayer(steps))),
    )
  })
})
