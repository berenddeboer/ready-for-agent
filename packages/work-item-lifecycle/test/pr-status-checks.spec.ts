import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
} from "@ready-for-agent/db-service/test"
import {
  GitHubService,
  type GitHubServiceShape,
  type PullRequestCheckStatus,
} from "@ready-for-agent/github-service"
import {
  KeymaxxerService,
  type KeymaxxerServiceShape,
} from "@ready-for-agent/keymaxxer-service"
import { Opencode } from "@ready-for-agent/opencode"
import {
  type LifecycleStepContext,
  investigatePrStatusChecks,
  makeWorkItemId,
  resolvePrMergeConflict,
  watchPrStatusChecks,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = makeRepositoryRecord({ localPath: "/repos/widgets" })
const mergeable = { mergeability: "mergeable", baseRefName: "main" } as const

const context: LifecycleStepContext = {
  workItemId: makeWorkItemId(),
  repositoryId: repository.id,
  githubIssueNumber: 42,
  model: "opencode/test-model",
  variant: "high",
  reviewModel: "opencode/test-model",
  reviewVariant: "high",
  worktreePath: "/tmp/worktree",
  sessionId: "ses_implement",
}

const db = stubDbServiceLayer({
  listRepositories: Effect.succeed([repository]),
})

const keymaxxer = Layer.succeed(KeymaxxerService, {
  initialize: Effect.void,
  hasSecret: () => Effect.succeed(true),
  findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
  findSecrets: () => Effect.succeed([]),
  addSecret: () => Effect.succeed(true),
  runWithSecrets: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
} satisfies KeymaxxerServiceShape)

const seedWorkItem = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = Date.now()
  yield* sql.unsafe(
    `INSERT INTO repository (
       id, github_owner, github_repo, local_path, is_bare, paused,
       issues_reconciled_at, created_at, updated_at
     ) VALUES (?, 'acme', 'widgets', '/repos/widgets', 1, 0, NULL, ?, ?)`,
    [repository.id, now, now],
  )
  yield* sql.unsafe(
    `INSERT INTO work_item (
       id, repository_id, github_issue_number, model, variant, review_model, review_variant, state,
       state_ready_at, worktree_path, session_id, failure_code, failure_message,
       created_at, updated_at
      ) VALUES (?, ?, 42, 'opencode/test-model', 'high', 'opencode/test-model', 'high',
        'watch_pr_status_checks', ?, '/tmp/worktree', 'ses_implement', NULL, NULL, ?, ?)`,
    [context.workItemId, repository.id, now, now, now],
  )
})

const githubWith = (status: PullRequestCheckStatus) =>
  Layer.succeed(GitHubService, {
    listReadyIssues: () => Effect.succeed([]),
    getOpenPullRequestNumber: () => Effect.succeed(1),
    getPullRequestCheckStatus: () => Effect.succeed(status),
    markPullRequestReadyForReview: () => Effect.void,
    mergePullRequest: () => Effect.void,
  } satisfies GitHubServiceShape)

const opencodeWith = (
  outputs: readonly string[],
  onContinue?: (prompt: string, sessionId: string) => void,
) => {
  let call = 0
  return Layer.succeed(
    Opencode,
    Opencode.of({
      start: () => Effect.die("unused"),
      continue: (input) => {
        onContinue?.(input.prompt, input.sessionId)
        const assistantText = outputs[call] ?? outputs.at(-1) ?? ""
        call += 1
        return Effect.succeed({ sessionId: input.sessionId, assistantText })
      },
      listModels: () => Effect.succeed([]),
    }),
  )
}

describe("PR status check steps", () => {
  it("checks the deterministic Work Item branch", async () => {
    let requestedBranch = ""
    const github = Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: (_repository, branch) => {
        requestedBranch = branch
        return Effect.succeed({
          _tag: "pending",
          terminalChecks: [],
          ...mergeable,
        })
      },
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.void,
    } satisfies GitHubServiceShape)

    const status = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        return yield* watchPrStatusChecks(context)
      }).pipe(Effect.provide(Layer.mergeAll(db, github, DatabaseTest))),
    )

    expect(status).toBe("pending")
    expect(requestedBranch).toBe(`rfa/acme-widgets/42/${context.workItemId}`)
  })

  it("hands off unhandled green results while the aggregate is still pending", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        return yield* watchPrStatusChecks(context)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "pending",
              ...mergeable,
              terminalChecks: [
                { externalId: "checkrun:1", name: "review", outcome: "green" },
              ],
            }),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(status).toBe("handoff_needed")
  })

  it("prioritizes a merge conflict and identifies every completed unhandled check for retirement", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        const status = yield* watchPrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        const rows = (yield* sql.unsafe(
          `SELECT id, handled_at FROM pr_status_check WHERE work_item_id = ?`,
          [context.workItemId],
        )) as readonly { id: string; handled_at: number | null }[]
        return { status, rows }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "failed",
              mergeability: "conflicting",
              baseRefName: "develop",
              terminalChecks: [
                { externalId: "checkrun:1", name: "lint", outcome: "red" },
                { externalId: "checkrun:2", name: "review", outcome: "green" },
              ],
            }),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result.status).toEqual({
      _tag: "conflict",
      retiredCheckIds: result.rows.map((row) => row.id),
    })
    expect(result.rows.every((row) => row.handled_at === null)).toBe(true)
  })

  it("preserves unhandled checks while mergeability is unknown", async () => {
    const statuses: PullRequestCheckStatus[] = [
      {
        _tag: "pending",
        mergeability: "unknown",
        baseRefName: "main",
        terminalChecks: [
          { externalId: "checkrun:1", name: "review", outcome: "green" },
        ],
      },
      {
        _tag: "pending",
        ...mergeable,
        terminalChecks: [],
      },
    ]
    let index = 0
    const github = Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[1]!),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.void,
    } satisfies GitHubServiceShape)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        const unknown = yield* watchPrStatusChecks(context)
        const known = yield* watchPrStatusChecks(context)
        return { unknown, known }
      }).pipe(Effect.provide(Layer.mergeAll(db, github, DatabaseTest))),
    )

    expect(result).toEqual({ unknown: "pending", known: "handoff_needed" })
  })

  it("does not re-hand off already handled checks and reports aggregate success", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        expect(yield* watchPrStatusChecks(context)).toBe("handoff_needed")
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE pr_status_check SET handled_at = ? WHERE work_item_id = ?`,
          [Date.now(), context.workItemId],
        )
        return yield* watchPrStatusChecks(context)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "succeeded",
              ...mergeable,
              terminalChecks: [
                { externalId: "checkrun:1", name: "unit", outcome: "green" },
              ],
            }),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(status).toBe("succeeded")
  })

  it("hands off a new execution of the same check name", async () => {
    const statuses: PullRequestCheckStatus[] = [
      {
        _tag: "failed",
        ...mergeable,
        terminalChecks: [
          { externalId: "checkrun:1", name: "lint", outcome: "red" },
        ],
      },
      {
        _tag: "failed",
        ...mergeable,
        terminalChecks: [
          { externalId: "checkrun:1", name: "lint", outcome: "red" },
          { externalId: "checkrun:2", name: "lint", outcome: "red" },
        ],
      },
    ]
    let index = 0
    const github = Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[1]!),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.void,
    } satisfies GitHubServiceShape)

    const second = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        expect(yield* watchPrStatusChecks(context)).toBe("handoff_needed")
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE pr_status_check SET handled_at = ? WHERE work_item_id = ?`,
          [Date.now(), context.workItemId],
        )
        return yield* watchPrStatusChecks(context)
      }).pipe(Effect.provide(Layer.mergeAll(db, github, DatabaseTest))),
    )

    expect(second).toBe("handoff_needed")
  })

  it("processes a red batch in a work turn followed by a verdict turn", async () => {
    const prompts: string[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        const investigation = yield* investigatePrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        const rows = (yield* sql.unsafe(
          `SELECT handled_at FROM pr_status_check WHERE work_item_id = ?`,
          [context.workItemId],
        )) as readonly { handled_at: number | null }[]
        return { investigation, rows }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "failed",
              ...mergeable,
              terminalChecks: [
                { externalId: "checkrun:1", name: "lint", outcome: "red" },
                { externalId: "checkrun:2", name: "unit", outcome: "red" },
              ],
            }),
            keymaxxer,
            opencodeWith(
              ["fixed and pushed", "READY_FOR_AGENT_RESULT: PROCESSED"],
              (prompt, sessionId) => {
                expect(sessionId).toBe("ses_implement")
                prompts.push(prompt)
              },
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result.investigation._tag).toBe("processed")
    expect(result.investigation.handledCheckIds).toHaveLength(2)
    expect(result.rows.every((row) => row.handled_at === null)).toBe(true)
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain("Diagnose and fix these failing checks")
    expect(prompts[0]).toContain("- lint")
    expect(prompts[0]).toContain("- unit")
    expect(prompts[0]).toContain(
      "Use Keymaxxer secret GITHUB_TOKEN_ACME_WIDGETS via keymaxxer_run",
    )
    expect(prompts[0]).not.toContain("automated reviews may have completed")
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: PROCESSED")
  })

  it("adds automated-review instructions when the batch contains a green check", async () => {
    const prompts: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        return yield* investigatePrStatusChecks(context)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "pending",
              ...mergeable,
              terminalChecks: [
                { externalId: "checkrun:1", name: "review", outcome: "green" },
                { externalId: "checkrun:2", name: "lint", outcome: "red" },
              ],
            }),
            keymaxxer,
            opencodeWith(
              ["done", "READY_FOR_AGENT_RESULT: PROCESSED"],
              (prompt) => {
                prompts.push(prompt)
              },
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(prompts[0]).toContain("- lint")
    expect(prompts[0]).toContain("automated reviews may have completed")
    expect(prompts[0]).toContain(
      "disregard reviews that are visibly still in progress",
    )
  })

  it("returns OpenCode's structured human intervention reason", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        return yield* investigatePrStatusChecks(context)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "failed",
              ...mergeable,
              terminalChecks: [
                { externalId: "checkrun:1", name: "deploy", outcome: "red" },
              ],
            }),
            keymaxxer,
            opencodeWith([
              "investigated",
              "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: A maintainer must approve deployment",
            ]),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result).toEqual({
      _tag: "needs_human",
      reason: "A maintainer must approve deployment",
      handledCheckIds: [expect.any(String)],
    })
  })

  it("resolves a merge conflict in a work turn followed by a verdict turn", async () => {
    const prompts: string[] = []
    const result = await Effect.runPromise(
      resolvePrMergeConflict(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            keymaxxer,
            opencodeWith(
              [
                "rebased, verified, and pushed",
                "READY_FOR_AGENT_RESULT: PROCESSED",
              ],
              (prompt, sessionId) => {
                expect(sessionId).toBe("ses_implement")
                prompts.push(prompt)
              },
            ),
          ),
        ),
      ),
    )

    expect(result).toEqual({ _tag: "processed" })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain("Fetch origin")
    expect(prompts[0]).toContain("current base branch")
    expect(prompts[0]).toContain("every current remote commit")
    expect(prompts[0]).toContain("--force-with-lease")
    expect(prompts[0]).toContain("exactly once")
    expect(prompts[0]).toContain(
      "Use Keymaxxer secret GITHUB_TOKEN_ACME_WIDGETS via keymaxxer_run",
    )
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: PROCESSED")
  })

  it("returns the merge-conflict resolver's human intervention reason", async () => {
    const result = await Effect.runPromise(
      resolvePrMergeConflict(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            keymaxxer,
            opencodeWith([
              "the second lease-protected push was rejected",
              "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: The PR branch changed during both push attempts",
            ]),
          ),
        ),
      ),
    )

    expect(result).toEqual({
      _tag: "needs_human",
      reason: "The PR branch changed during both push attempts",
    })
  })

  it("leaves checks unhandled after malformed verdict output", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        const investigation = yield* Effect.result(
          investigatePrStatusChecks(context),
        )
        const sql = yield* SqlClient.SqlClient
        const observed = (yield* sql.unsafe(
          `SELECT handled_at FROM pr_status_check WHERE work_item_id = ?`,
          [context.workItemId],
        )) as readonly { handled_at: number | null }[]
        return { investigation, observed }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "failed",
              ...mergeable,
              terminalChecks: [
                { externalId: "checkrun:1", name: "lint", outcome: "red" },
              ],
            }),
            keymaxxer,
            opencodeWith(["fixed", "I forgot the marker"]),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result.investigation._tag).toBe("Failure")
    expect(result.observed.every((row) => row.handled_at === null)).toBe(true)
  })

  it("rejects conflicting verdict markers and leaves checks unhandled", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        const investigation = yield* Effect.result(
          investigatePrStatusChecks(context),
        )
        const sql = yield* SqlClient.SqlClient
        const observed = (yield* sql.unsafe(
          `SELECT handled_at FROM pr_status_check WHERE work_item_id = ?`,
          [context.workItemId],
        )) as readonly { handled_at: number | null }[]
        return { investigation, observed }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "failed",
              ...mergeable,
              terminalChecks: [
                { externalId: "checkrun:1", name: "lint", outcome: "red" },
              ],
            }),
            keymaxxer,
            opencodeWith([
              "fixed",
              [
                "READY_FOR_AGENT_RESULT: PROCESSED",
                "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: approval required",
              ].join("\n"),
            ]),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result.investigation._tag).toBe("Failure")
    expect(result.observed.every((row) => row.handled_at === null)).toBe(true)
  })
})
