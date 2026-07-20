import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { DatabaseTest } from "@ready-for-agent/db/test"
import {
  makeRepositoryRecord,
  stubDbServiceLayer,
} from "@ready-for-agent/db-service/test"
import {
  GitHubRequestError,
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
const mergeable = {
  mergeability: "mergeable",
  baseRefName: "main",
  headPushedAt: null,
} as const

const context: LifecycleStepContext = {
  workItemId: makeWorkItemId(),
  repositoryId: repository.id,
  githubIssueNumber: 42,
  model: "opencode/test-model",
  variant: "high",
  reviewModel: "opencode/test-model",
  reviewVariant: "high",
  worktreePath: "/tmp/worktree",
  startingCommitOid: null,
  completionSummary: null,
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

const githubWith = (
  status: PullRequestCheckStatus,
  overrides: Partial<GitHubServiceShape> = {},
) =>
  Layer.succeed(GitHubService, {
    listReadyIssues: () => Effect.succeed([]),
    getOpenPullRequestNumber: () => Effect.succeed(1),
    getPullRequestCheckStatus: () => Effect.succeed(status),
    getPrStatusCheckDiagnostics: () => Effect.succeed([]),
    getPullRequestLifecycleStatus: () =>
      Effect.succeed({ _tag: "open" as const }),
    markPullRequestReadyForReview: () => Effect.void,
    mergePullRequest: () => Effect.void,
    ensureIssueCompletedWithSummary: () => Effect.void,
    ...overrides,
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
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.void,
      ensureIssueCompletedWithSummary: () => Effect.void,
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

  it("forwards no_checks headPushedAt from the GitHub check snapshot", async () => {
    const headPushedAt = new Date("2026-07-17T10:00:00.000Z")
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        return yield* watchPrStatusChecks(context)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "no_checks",
              ...mergeable,
              headPushedAt,
            }),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(status).toEqual({
      _tag: "no_checks",
      headPushedAt,
    })
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
              headPushedAt: null,
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
        headPushedAt: null,
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
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.void,
      ensureIssueCompletedWithSummary: () => Effect.void,
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
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.void,
      ensureIssueCompletedWithSummary: () => Effect.void,
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

  it("retires a failed execution after a manually rerun check makes the aggregate green", async () => {
    const statuses: PullRequestCheckStatus[] = [
      {
        _tag: "failed",
        ...mergeable,
        terminalChecks: [
          { externalId: "checkrun:1", name: "lint", outcome: "red" },
        ],
      },
      {
        _tag: "succeeded",
        ...mergeable,
        terminalChecks: [
          { externalId: "checkrun:1", name: "lint", outcome: "red" },
          { externalId: "checkrun:2", name: "lint", outcome: "green" },
        ],
      },
    ]
    let index = 0
    const github = Layer.succeed(GitHubService, {
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[1]!),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.void,
      ensureIssueCompletedWithSummary: () => Effect.void,
    } satisfies GitHubServiceShape)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        expect(yield* watchPrStatusChecks(context)).toBe("handoff_needed")
        const status = yield* watchPrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        const rows = (yield* sql.unsafe(
          `SELECT external_id, handled_at
           FROM pr_status_check
           WHERE work_item_id = ?
           ORDER BY external_id`,
          [context.workItemId],
        )) as readonly {
          readonly external_id: string
          readonly handled_at: number | null
        }[]
        return { status, rows }
      }).pipe(Effect.provide(Layer.mergeAll(db, github, DatabaseTest))),
    )

    expect(result.status).toBe("handoff_needed")
    expect(result.rows).toEqual([
      { external_id: "checkrun:1", handled_at: expect.any(Number) },
      { external_id: "checkrun:2", handled_at: null },
    ])
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
            githubWith(
              {
                _tag: "failed",
                ...mergeable,
                terminalChecks: [
                  {
                    externalId: "actions-job:88026385443",
                    name: "lint",
                    outcome: "red",
                  },
                  {
                    externalId: "actions-job:88026385444",
                    name: "unit",
                    outcome: "red",
                  },
                ],
              },
              {
                getPrStatusCheckDiagnostics: () =>
                  Effect.succeed([
                    {
                      externalId: "actions-job:88026385443",
                      name: "lint",
                      source: "actions-job" as const,
                      htmlUrl:
                        "https://github.com/acme/widgets/actions/runs/1/job/88026385443",
                      logFetch: {
                        _tag: "ok" as const,
                        excerpt: "error TS6305: typecheck failed",
                        localPath:
                          "/tmp/worktree/.ready-for-agent/status-check-logs/actions-job-88026385443.log",
                      },
                    },
                    {
                      externalId: "actions-job:88026385444",
                      name: "unit",
                      source: "actions-job" as const,
                      htmlUrl: null,
                      logFetch: {
                        _tag: "ok" as const,
                        excerpt: "1 test failed",
                        localPath: null,
                      },
                    },
                  ]),
              },
            ),
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
    expect(prompts[0]).toContain(
      "- lint (external id: actions-job:88026385443, source: Actions job)",
    )
    expect(prompts[0]).toContain(
      "- unit (external id: actions-job:88026385444, source: Actions job)",
    )
    expect(prompts[0]).toContain(
      "Fine-grained GitHub PATs often cannot use the Checks API",
    )
    expect(prompts[0]).toContain("--method GET")
    expect(prompts[0]).toContain("Harness diagnostics for the red checks")
    expect(prompts[0]).toContain("error TS6305: typecheck failed")
    expect(prompts[0]).toContain(
      "/tmp/worktree/.ready-for-agent/status-check-logs/actions-job-88026385443.log",
    )
    expect(prompts[0]).toContain(
      "Use Keymaxxer secret GITHUB_TOKEN_ACME_WIDGETS via keymaxxer_run",
    )
    expect(prompts[0]).not.toContain("automated reviews may have completed")
    expect(prompts[0]).toContain("restart the failed checks when appropriate")
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: PROCESSED")
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: FAILED:")
    expect(prompts[1]).toContain(
      "If this handoff contained red checks and you made no commit, push, check restart",
    )
    expect(prompts[1]).toContain("replacement execution")
  })

  it("makes a focused recovery attempt after FAILED and accepts recovered progress", async () => {
    const prompts: string[] = []
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
                { externalId: "checkrun:1", name: "lint", outcome: "red" },
              ],
            }),
            keymaxxer,
            opencodeWith(
              [
                "No code changes, commit, push, or PR comment were made.",
                "READY_FOR_AGENT_RESULT: FAILED: ActionLint failed on GitHub 503",
                "Reran the failed workflow; a replacement execution is queued.",
                "READY_FOR_AGENT_RESULT: PROCESSED",
              ],
              (prompt) => prompts.push(prompt),
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result).toEqual({
      _tag: "processed",
      handledCheckIds: [expect.any(String)],
    })
    expect(prompts).toHaveLength(4)
    expect(prompts[2]).toContain("focused recovery attempt")
    expect(prompts[2]).toContain("ActionLint failed on GitHub 503")
    expect(prompts[2]).toContain("get the pull request out of its red state")
    expect(prompts[2]).toContain("Do not create an empty or no-op commit")
    expect(prompts[3]).toContain("READY_FOR_AGENT_RESULT: FAILED:")
  })

  it("fails retryably after the focused recovery attempt still cannot act", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        return yield* Effect.result(investigatePrStatusChecks(context))
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
              "No safe action was available.",
              "READY_FOR_AGENT_RESULT: FAILED: ActionLint failed on GitHub 503",
              "I checked the current PR and cannot safely restart or change it.",
              "READY_FOR_AGENT_RESULT: FAILED: No autonomous recovery action remains",
            ]),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.failure)).toContain("Manual fixing may be required")
      expect(String(result.failure)).toContain(
        "fix or rerun the checks on GitHub, then click Retry checks",
      )
      expect(String(result.failure)).toContain(
        "No autonomous recovery action remains",
      )
    }
  })

  it("fails the investigate step when harness diagnostics cannot load", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        return yield* Effect.result(investigatePrStatusChecks(context))
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith(
              {
                _tag: "failed",
                ...mergeable,
                terminalChecks: [
                  {
                    externalId: "actions-job:200",
                    name: "lint",
                    outcome: "red",
                  },
                ],
              },
              {
                getPrStatusCheckDiagnostics: () =>
                  Effect.fail(
                    new GitHubRequestError({
                      message: "Actions API unauthorized",
                      statusCode: 401,
                    }),
                  ),
              },
            ),
            keymaxxer,
            opencodeWith(["should not run"]),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.failure)).toContain(
        "Failed to load PR Status Check diagnostics",
      )
    }
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

    expect(prompts[0]).toContain(
      "- lint (external id: checkrun:2, source: unknown source)",
    )
    expect(prompts[0]).toContain("automated reviews may have completed")
    expect(prompts[0]).toContain(
      "disregard reviews that are visibly still in progress",
    )
    expect(prompts[0]).toContain(
      "If review feedback requires changes, verify them, commit them, and push the commit",
    )
    expect(prompts[0]).toContain(
      "post one comment on the existing pull request that includes the commit SHA",
    )
    expect(prompts[0]).toContain(
      "lists any review feedback declined with a brief reason",
    )
    expect(prompts[0]).toContain(
      "Do not post this summary comment when you did not create a commit",
    )
  })

  it("allows PROCESSED for a green-only review handoff with nothing to address", async () => {
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
              _tag: "succeeded",
              ...mergeable,
              terminalChecks: [
                { externalId: "checkrun:1", name: "review", outcome: "green" },
              ],
            }),
            keymaxxer,
            opencodeWith([
              "No review feedback needed changes.",
              "READY_FOR_AGENT_RESULT: PROCESSED",
            ]),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result).toEqual({
      _tag: "processed",
      handledCheckIds: [expect.any(String)],
    })
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
