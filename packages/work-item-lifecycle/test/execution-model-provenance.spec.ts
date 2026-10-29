import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import {
  AGENT_BACKEND_IDS,
  getBuiltInAgentBackend,
} from "@ready-for-agent/agent-backend"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbService, DbServiceLive } from "@ready-for-agent/db-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  WorkItemLifecycle,
  WorkItemLifecycleLive,
  stubActiveAgentBackendLayer,
  stubAzureDevOpsServiceLayer,
  stubGitHubServiceLayer,
  stubGitLabServiceLayer,
  stubLinearServiceLayer,
} from "../src/index.js"
import { modelsSelectedForExecution } from "../src/lib/execution-model-provenance.js"
import { loadTimingHistory } from "../src/lib/timing-history.js"
import { describe, expect, it } from "bun:test"

const claude = getBuiltInAgentBackend(AGENT_BACKEND_IDS.claude)
if (claude === undefined) {
  throw new Error("Claude Agent Backend registration is missing")
}

describe("models selected for an execution", () => {
  const selection = {
    model: " provider/build ",
    reviewModel: " provider/review ",
  }

  it("records build only for non-review agent steps", () => {
    expect(modelsSelectedForExecution("implement", selection)).toEqual([
      { role: "build", model: "provider/build" },
    ])
    expect(modelsSelectedForExecution("pre_commit", selection)).toEqual([
      { role: "build", model: "provider/build" },
    ])
  })

  it("records both roles for review and ignores an unused review model elsewhere", () => {
    expect(modelsSelectedForExecution("review", selection)).toEqual([
      { role: "review", model: "provider/review" },
      { role: "build", model: "provider/build" },
    ])
    expect(
      modelsSelectedForExecution("implement", {
        model: "provider/build",
        reviewModel: "provider/review",
      }).map((row) => row.model),
    ).toEqual(["provider/build"])
  })

  it("records nothing for agent-free steps or blank models", () => {
    expect(modelsSelectedForExecution("create_worktree", selection)).toEqual([])
    expect(modelsSelectedForExecution("merge_pr", selection)).toEqual([])
    expect(
      modelsSelectedForExecution("implement", {
        model: "  ",
        reviewModel: "provider/review",
      }),
    ).toEqual([])
  })
})

const steps: LifecycleStepsShape = {
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

const lifecycleLayer = WorkItemLifecycleLive.pipe(
  Layer.provideMerge(stubActiveAgentBackendLayer({ registration: claude })),
  Layer.provideMerge(stubGitHubServiceLayer()),
  Layer.provideMerge(stubGitLabServiceLayer()),
  Layer.provideMerge(stubAzureDevOpsServiceLayer()),
  Layer.provideMerge(stubLinearServiceLayer()),
  Layer.provideMerge(Layer.succeed(LifecycleSteps, LifecycleSteps.of(steps))),
  Layer.provideMerge(DbServiceLive),
  Layer.provideMerge(SqliteQueueServiceLive),
  Layer.provideMerge(DatabaseTest),
)

const config = (
  build: string,
  review: string,
): {
  selectedAgentBackend: string
  defaultModel: string
  defaultThinkingLevel: string
  reviewModel: string
  reviewThinkingLevel: null
  maxConcurrentAgentTurns: number
  maxConcurrentWorkItems: number
} => ({
  selectedAgentBackend: "claude",
  defaultModel: build,
  defaultThinkingLevel: "low",
  reviewModel: review,
  reviewThinkingLevel: null,
  maxConcurrentAgentTurns: 2,
  maxConcurrentWorkItems: 5,
})

describe("execution model provenance", () => {
  it("records the model selected for each execution and leaves legacy history unknown", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService
        const sql = yield* SqlClient.SqlClient
        const lifecycle = yield* WorkItemLifecycle
        const repo = yield* db.addRepository({
          forge: "github",
          forgeHost: "github.com",
          projectPath: "acme/widgets",
          localPath: "/repos/acme/widgets.git",
          isBare: true,
        })
        yield* db.updateConfig(config("provider/build-a", "provider/review-a"))
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
        const recorded = new Map<string, string>()
        let current = created
        for (let guard = 0; guard < 8; guard++) {
          const queued = current.stepRuns.find((run) => run.status === "queued")
          if (queued === undefined) break
          if (queued.step === "implement") {
            yield* db.updateConfig(
              config("provider/build-b", "provider/review-b"),
            )
          }
          if (queued.step === "review") {
            yield* db.updateConfig(
              config("provider/build-c", "provider/review-c"),
            )
          }
          const result = yield* lifecycle.runStep(queued.id)
          if (result._tag !== "processed") {
            throw new Error(`expected ${queued.step} to process`)
          }
          recorded.set(queued.step, queued.id)
          current = result.workItem
          if (queued.step === "review") break
        }
        expect(recorded.has("review")).toBe(true)

        const rows = (yield* sql.unsafe(
          `SELECT sr.step, m.role, m.model
           FROM step_run_agent_model m
           INNER JOIN step_run sr ON sr.id = m.step_run_id
           ORDER BY sr.queued_at, m.role`,
        )) as ReadonlyArray<{
          readonly step: string
          readonly role: string
          readonly model: string
        }>
        expect(rows.filter((row) => row.step === "create_worktree")).toEqual([])
        expect(
          rows.filter((row) => row.step === "install_dependencies"),
        ).toEqual([
          {
            step: "install_dependencies",
            role: "build",
            model: "provider/build-a",
          },
        ])
        expect(rows.filter((row) => row.step === "implement")).toEqual([
          { step: "implement", role: "build", model: "provider/build-b" },
        ])
        expect(rows.filter((row) => row.step === "review")).toEqual([
          { step: "review", role: "build", model: "provider/build-c" },
          { step: "review", role: "review", model: "provider/review-c" },
        ])
        expect(rows.map((row) => row.model)).not.toContain("provider/review-a")
        expect(rows.map((row) => row.model)).not.toContain("provider/review-b")

        yield* db.updateConfig(
          config("provider/later", "provider/later-review"),
        )
        yield* sql.unsafe(
          `UPDATE work_item SET state = 'complete', state_ready_at = 5_000 WHERE id = ?`,
          [created.id],
        )
        const history = yield* loadTimingHistory(sql, {
          repositoryId: repo.id,
          fromMs: null,
          toMs: 9_000,
          agentBackend: null,
          model: null,
          unknownModel: false,
        })
        expect(history.items.map((item) => item.models)).toEqual([
          [
            "provider/build-a",
            "provider/build-b",
            "provider/build-c",
            "provider/review-c",
          ],
        ])
        expect(history.items[0]?.modelHistory).toBe("complete")
        expect(
          history.choices.models.map((choice) => choice.model),
        ).not.toContain("provider/later")

        yield* sql.unsafe(
          `INSERT INTO work_item (
             id, repository_id, issue_number, state, state_ready_at,
             agent_backend, execution_profile_present, execution_profile_build_model,
             created_at, updated_at
           ) VALUES ('legacy', ?, 2, 'complete', 4000, 'claude', 1, 'profile-only', 0, 4000)`,
          [repo.id],
        )
        const withLegacy = yield* loadTimingHistory(sql, {
          repositoryId: repo.id,
          fromMs: null,
          toMs: 9_000,
          agentBackend: null,
          model: null,
          unknownModel: false,
        })
        expect(
          withLegacy.items.find((item) => item.id === "legacy"),
        ).toMatchObject({
          models: [],
          modelHistory: "unknown",
        })
        expect(
          withLegacy.choices.models.map((choice) => choice.model),
        ).not.toContain("profile-only")
        expect(
          withLegacy.choices.models.map((choice) => choice.model),
        ).not.toContain("provider/later")
      }).pipe(Effect.provide(lifecycleLayer)),
    )
  })
})
