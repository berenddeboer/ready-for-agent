import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import { DbServiceLive } from "@ready-for-agent/db-service"
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
  readonly state: string
  readonly stateReadyAt: number
  readonly createdAt?: number
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const createdAt = input.createdAt ?? input.stateReadyAt
    yield* sql.unsafe(
      `INSERT INTO work_item (
         id, repository_id, issue_number, issue_title, pull_request_number,
         state, state_ready_at,
         worktree_path, session_id, failure_code, failure_message,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?,
         NULL, NULL, NULL, NULL, ?, ?)`,
      [
        input.workItemId,
        input.repositoryId,
        input.issueNumber,
        `Issue ${input.issueNumber}`,
        input.state,
        input.stateReadyAt,
        createdAt,
        input.stateReadyAt,
      ],
    )
  })

describe("listCompletedWorkItems", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z")
  const hourMs = 60 * 60 * 1000

  it("returns Complete and Abandoned across repositories ordered by stateReadyAt newest-first", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-a", now)
        yield* seedRepository("repo-b", now)

        yield* seedWorkItem({
          workItemId: "wi-old-complete",
          repositoryId: "repo-a",
          issueNumber: 1,
          state: "complete",
          stateReadyAt: now - 48 * hourMs,
        })
        yield* seedWorkItem({
          workItemId: "wi-mid-abandoned",
          repositoryId: "repo-b",
          issueNumber: 2,
          state: "abandoned",
          stateReadyAt: now - 30 * hourMs,
        })
        yield* seedWorkItem({
          workItemId: "wi-new-complete",
          repositoryId: "repo-a",
          issueNumber: 3,
          state: "complete",
          stateReadyAt: now - hourMs,
        })
        yield* seedWorkItem({
          workItemId: "wi-implementing",
          repositoryId: "repo-a",
          issueNumber: 4,
          state: "implement",
          stateReadyAt: now,
        })
        yield* seedWorkItem({
          workItemId: "wi-failed",
          repositoryId: "repo-b",
          issueNumber: 5,
          state: "failed",
          stateReadyAt: now - 2 * hourMs,
        })

        const page = yield* lifecycle.listCompletedWorkItems({
          page: 1,
          pageSize: 20,
        })

        expect(page.totalCount).toBe(3)
        expect(page.page).toBe(1)
        expect(page.pageSize).toBe(20)
        expect(page.items.map((item) => item.id)).toEqual([
          "wi-new-complete",
          "wi-mid-abandoned",
          "wi-old-complete",
        ])
        // Items older than 24 h are included (historical view).
        expect(page.items.map((item) => item.id)).toContain("wi-old-complete")
        expect(page.items.map((item) => item.id)).toContain("wi-mid-abandoned")
      }),
    ))

  it("paginates with stable page boundaries", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-page", now)

        for (let index = 0; index < 25; index += 1) {
          yield* seedWorkItem({
            workItemId: `wi-page-${String(index).padStart(2, "0")}`,
            repositoryId: "repo-page",
            issueNumber: index + 1,
            state: index % 2 === 0 ? "complete" : "abandoned",
            // Newer index => newer stateReadyAt so order is wi-page-24 … wi-page-00
            stateReadyAt: now - (25 - index) * hourMs,
          })
        }

        const first = yield* lifecycle.listCompletedWorkItems({
          page: 1,
          pageSize: 20,
        })
        const second = yield* lifecycle.listCompletedWorkItems({
          page: 2,
          pageSize: 20,
        })
        const empty = yield* lifecycle.listCompletedWorkItems({
          page: 3,
          pageSize: 20,
        })

        expect(first.totalCount).toBe(25)
        expect(first.items).toHaveLength(20)
        expect(second.items).toHaveLength(5)
        expect(empty.items).toHaveLength(0)

        const firstIds = first.items.map((item) => item.id)
        const secondIds = second.items.map((item) => item.id)
        expect(firstIds[0]).toBe("wi-page-24")
        expect(firstIds[19]).toBe("wi-page-05")
        expect(secondIds).toEqual([
          "wi-page-04",
          "wi-page-03",
          "wi-page-02",
          "wi-page-01",
          "wi-page-00",
        ])
        // No overlap between pages.
        expect(new Set([...firstIds, ...secondIds]).size).toBe(25)
      }),
    ))

  it("clamps pageSize to the shared max and page below 1 to 1", () =>
    runTest(
      Effect.gen(function* () {
        const lifecycle = yield* WorkItemLifecycle
        yield* seedRepository("repo-clamp", now)
        for (let index = 0; index < 5; index += 1) {
          yield* seedWorkItem({
            workItemId: `wi-clamp-${index}`,
            repositoryId: "repo-clamp",
            issueNumber: index + 1,
            state: "complete",
            stateReadyAt: now - index * hourMs,
          })
        }

        const oversized = yield* lifecycle.listCompletedWorkItems({
          page: 0,
          pageSize: 500,
        })
        expect(oversized.page).toBe(1)
        expect(oversized.pageSize).toBe(100)
        expect(oversized.items).toHaveLength(5)
      }),
    ))
})
