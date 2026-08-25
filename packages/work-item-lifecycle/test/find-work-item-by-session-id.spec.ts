import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbServiceLive } from "@ready-for-agent/db-service"
import { SqliteQueueServiceLive } from "@ready-for-agent/sqlite-queue-service"
import {
  LifecycleSteps,
  type LifecycleStepsShape,
  SessionIdAmbiguousError,
  SessionIdNotFoundError,
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
      _tag: "succeeded" as const,
      createdAt: new Date(0),
      headSha: "settled-head",
      headPushedAt: new Date(0),
      isDraft: true,
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

const TestLayer = WorkItemLifecycleLive.pipe(
  Layer.provideMerge(stubActiveAgentBackendLayer()),
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

const runTest = <A, E>(
  effect: Effect.Effect<A, E, Layer.Layer.Success<typeof TestLayer>>,
) => Effect.runPromise(Effect.provide(effect, TestLayer))

const seedRepository = (repositoryId: string, now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `INSERT INTO repository (
         id, forge, forge_host, project_path, local_path, is_bare, paused,
         issues_reconciled_at, created_at, updated_at
       ) VALUES (?, 'github', 'github.com', ?, ?, 1, 0, NULL, ?, ?)`,
      [repositoryId, repositoryId, `/tmp/${repositoryId}`, now, now],
    )
  })

const seedWorkItem = (input: {
  readonly workItemId: string
  readonly repositoryId: string
  readonly issueNumber: number
  readonly agentBackend?: string
  readonly sessionId: string | null
  readonly worktreePath: string | null
  readonly now: number
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(
      `INSERT INTO work_item (
         id, repository_id, issue_number, issue_title, pull_request_number,
         agent_backend, state, state_ready_at,
         worktree_path, session_id, failure_code, failure_message,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, ?, 'implement', ?,
         ?, ?, NULL, NULL, ?, ?)`,
      [
        input.workItemId,
        input.repositoryId,
        input.issueNumber,
        `Issue ${input.issueNumber}`,
        input.agentBackend ?? "opencode",
        input.now,
        input.worktreePath,
        input.sessionId,
        input.now,
        input.now,
      ],
    )
  })

describe("findWorkItemBySessionId", () => {
  const now = Date.parse("2026-08-13T12:00:00.000Z")
  const sessionId = "85312e9f-9c57-42ef-9757-b2512cee57cd"

  it("fails as not found when no Work Item owns the Session ID", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-none", now)
        yield* seedWorkItem({
          workItemId: "wi-other-session",
          repositoryId: "repo-none",
          issueNumber: 1,
          sessionId: "other-session",
          worktreePath: "/tmp/worktrees/other",
          now,
        })

        const error = yield* Effect.flip(
          lifecycle.findWorkItemBySessionId(sessionId),
        )

        expect(error).toBeInstanceOf(SessionIdNotFoundError)
        expect(error._tag).toBe("SessionIdNotFoundError")
        if (error._tag === "SessionIdNotFoundError") {
          expect(error.sessionId).toBe(sessionId)
        }
      }),
    ))

  it("returns the captured backend, Session ID, and worktree for exactly one match", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-one", now)
        yield* seedWorkItem({
          workItemId: "wi-owner",
          repositoryId: "repo-one",
          issueNumber: 7,
          agentBackend: "grok",
          sessionId,
          worktreePath: "/tmp/worktrees/acme-widgets-7",
          now,
        })
        yield* seedWorkItem({
          workItemId: "wi-unrelated",
          repositoryId: "repo-one",
          issueNumber: 8,
          sessionId: "unrelated-session",
          worktreePath: "/tmp/worktrees/other",
          now,
        })

        const found = yield* lifecycle.findWorkItemBySessionId(sessionId)

        expect(found).toEqual({
          agentBackend: "grok",
          sessionId,
          worktreePath: "/tmp/worktrees/acme-widgets-7",
        })
      }),
    ))

  it("fails as ambiguous when more than one Work Item owns the Session ID", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-a", now)
        yield* seedRepository("repo-b", now)
        yield* seedWorkItem({
          workItemId: "wi-first",
          repositoryId: "repo-a",
          issueNumber: 1,
          agentBackend: "opencode",
          sessionId,
          worktreePath: "/tmp/worktrees/first",
          now,
        })
        yield* seedWorkItem({
          workItemId: "wi-second",
          repositoryId: "repo-b",
          issueNumber: 2,
          agentBackend: "claude",
          sessionId,
          worktreePath: "/tmp/worktrees/second",
          now,
        })

        const error = yield* Effect.flip(
          lifecycle.findWorkItemBySessionId(sessionId),
        )

        expect(error).toBeInstanceOf(SessionIdAmbiguousError)
        expect(error._tag).toBe("SessionIdAmbiguousError")
        if (error._tag === "SessionIdAmbiguousError") {
          expect(error.sessionId).toBe(sessionId)
        }
      }),
    ))
})
