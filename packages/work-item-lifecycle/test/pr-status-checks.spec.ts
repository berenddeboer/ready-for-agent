import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentBackend } from "@ready-for-agent/agent-backend"
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
import {
  AUTOMATED_REVIEW_RERUN_LIMIT,
  type LifecycleStepContext,
  automatedReviewRerunLimitReason,
  investigatePrStatusChecks,
  makeWorkItemId,
  parseInvestigationResult,
  resolvePrMergeConflict,
  watchPrStatusChecks,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

const repository = makeRepositoryRecord({ localPath: "/repos/widgets" })
const mergeable = {
  mergeability: "mergeable",
  baseRefName: "main",
  headPushedAt: null,
  headSha: null,
  createdAt: null,
  isDraft: null,
} as const

const context: LifecycleStepContext = {
  workItemId: makeWorkItemId(),
  repositoryId: repository.id,
  githubIssueNumber: 42,
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
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
       id, repository_id, github_issue_number, model, thinking_level, review_model, review_thinking_level, state,
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
    getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
    listReadyIssues: () => Effect.succeed([]),
    getOpenPullRequestNumber: () => Effect.succeed(1),
    getPullRequestCheckStatus: () => Effect.succeed(status),
    getPrStatusCheckDiagnostics: () => Effect.succeed([]),
    getPullRequestLifecycleStatus: () =>
      Effect.succeed({ _tag: "open" as const }),
    markPullRequestReadyForReview: () => Effect.void,
    mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
    rerunWorkflowRun: () => Effect.void,
    ensureIssueCompletedWithSummary: () => Effect.void,
    ...overrides,
  } satisfies GitHubServiceShape)

const opencodeWith = (
  outputs: readonly string[],
  onContinue?: (prompt: string, sessionId: string) => void,
) => {
  let call = 0
  return Layer.succeed(
    AgentBackend,
    AgentBackend.of({
      startTurn: () => Effect.die("unused"),
      continueTurn: (input) => {
        onContinue?.(input.prompt, input.sessionId)
        const assistantText = outputs[call] ?? outputs.at(-1) ?? ""
        call += 1
        return Effect.succeed({ sessionId: input.sessionId, assistantText })
      },
      inspect: () =>
        Effect.succeed({
          backend: { id: "opencode" as const, label: "OpenCode" },
          models: [],
        }),
    }),
  )
}

describe("PR status check steps", () => {
  it("checks the deterministic Work Item branch", async () => {
    let requestedBranch = ""
    const github = Layer.succeed(GitHubService, {
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
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
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      rerunWorkflowRun: () => Effect.void,
      ensureIssueCompletedWithSummary: () => Effect.void,
    } satisfies GitHubServiceShape)

    const status = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        return yield* watchPrStatusChecks(context)
      }).pipe(Effect.provide(Layer.mergeAll(db, github, DatabaseTest))),
    )

    expect(status._tag).toBe("pending")
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
      headSha: null,
      createdAt: null,
      isDraft: null,
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

    expect(status._tag).toBe("handoff_needed")
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
              headSha: null,
              createdAt: null,
              isDraft: null,
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
      headPushedAt: null,
      headSha: null,
      createdAt: null,
      isDraft: null,
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
        headSha: null,
        createdAt: null,
        isDraft: null,
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
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[1]!),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      rerunWorkflowRun: () => Effect.void,
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

    expect(result.unknown._tag).toBe("pending")
    expect(result.known._tag).toBe("handoff_needed")
  })

  it("does not re-hand off already handled checks and reports aggregate success", async () => {
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        expect((yield* watchPrStatusChecks(context))._tag).toBe(
          "handoff_needed",
        )
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

    expect(status._tag).toBe("succeeded")
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
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[1]!),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      rerunWorkflowRun: () => Effect.void,
      ensureIssueCompletedWithSummary: () => Effect.void,
    } satisfies GitHubServiceShape)

    const second = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        expect((yield* watchPrStatusChecks(context))._tag).toBe(
          "handoff_needed",
        )
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE pr_status_check SET handled_at = ? WHERE work_item_id = ?`,
          [Date.now(), context.workItemId],
        )
        return yield* watchPrStatusChecks(context)
      }).pipe(Effect.provide(Layer.mergeAll(db, github, DatabaseTest))),
    )

    expect(second._tag).toBe("handoff_needed")
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
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[1]!),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      getPullRequestLifecycleStatus: () =>
        Effect.succeed({ _tag: "open" as const }),
      markPullRequestReadyForReview: () => Effect.void,
      mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
      rerunWorkflowRun: () => Effect.void,
      ensureIssueCompletedWithSummary: () => Effect.void,
    } satisfies GitHubServiceShape)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        expect((yield* watchPrStatusChecks(context))._tag).toBe(
          "handoff_needed",
        )
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

    expect(result.status._tag).toBe("handoff_needed")
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
              ["fixed and pushed", "READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED"],
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

    expect(result.investigation._tag).toBe("checks_triggered")
    if (result.investigation._tag === "checks_triggered") {
      expect(result.investigation.checkStartAnchorRecorded).toBe(false)
    }
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
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED")
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: PROCESSED")
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: FAILED:")
    expect(prompts[1]).toContain(
      "If this handoff contained red checks and you made no commit, push, check restart",
    )
    expect(prompts[1]).toContain("replacement check executions")
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
                "READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED",
              ],
              (prompt) => prompts.push(prompt),
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result).toEqual({
      _tag: "checks_triggered",
      handledCheckIds: [expect.any(String)],
      checkStartAnchorRecorded: false,
    })
    expect(prompts).toHaveLength(4)
    expect(prompts[2]).toContain("focused recovery attempt")
    expect(prompts[2]).toContain("ActionLint failed on GitHub 503")
    expect(prompts[2]).toContain("process the PR Status Check Handoff")
    expect(prompts[2]).toContain("retry the failed inspection")
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

  it("distinguishes terminal, active, stale, and completed automated reviews for a green check", async () => {
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
      "Do not assume an automated review exists merely because CI is present",
    )
    expect(prompts[0]).toContain(
      'Workflow or job names alone (including names containing "review" or "PR Review") are not positive review evidence',
    )
    expect(prompts[0]).toContain(
      "Positive evidence requires an executed reviewer job or step, or a comment from a recognized automated reviewer",
    )
    expect(prompts[0]).toContain(
      "A skipped workflow or job with no executed reviewer steps and no recognized automated-review comment is not an incomplete review",
    )
    expect(prompts[0]).toContain(
      "If no relevant automated-review run or comment exists, that is a normal no-op",
    )
    expect(prompts[0]).toContain(
      "Do not request a review workflow rerun solely because a skipped reviewer produced no comment",
    )
    expect(prompts[0]).toContain(
      "stop semantically incomplete even when GitHub reports its check and workflow as successful",
    )
    expect(prompts[0]).toContain(
      "finished banner combined with unchecked substantive review tasks",
    )
    expect(prompts[0]).toContain("remaining working spinner")
    expect(prompts[0]).toContain("no final findings or synthesis")
    expect(prompts[0]).toContain(
      "Do not treat arbitrary Markdown checkboxes in unrelated pull-request comments",
    )
    expect(prompts[0]).toContain(
      "latest relevant comment with the latest relevant run attempt",
    )
    expect(prompts[0]).toContain(
      "stale incomplete comment when a newer attempt completed its review successfully",
    )
    expect(prompts[0]).toContain(
      "Once an automated-review check is terminal, its Automated Review Output is final",
    )
    expect(prompts[0]).toContain(
      "successful terminal review with no relevant comment means no feedback and must not be rerun",
    )
    expect(prompts[0]).not.toContain("WAITING")
    expect(prompts[0]).toContain(
      "Present, positively identified, visibly incomplete Automated Review Output requires a whole-review workflow rerun",
    )
    expect(prompts[0]).toContain(
      "Do not call GitHub workflow rerun APIs yourself",
    )
    expect(prompts[0]).toContain("Do not use a failed-jobs-only rerun")
    expect(prompts[0]).toContain(
      "Report FAILED for a technical inability to inspect the relevant review state",
    )
    expect(prompts[0]).toContain(
      "Report NEEDS_HUMAN only when evidence shows that an operator must perform or decide",
    )
    expect(prompts[0]).toContain(
      "successful terminal review with no relevant comment, still needs no changes or rerun",
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

  it("allows PROCESSED for a green-only handoff with no review or nothing to address", async () => {
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
              _tag: "succeeded",
              ...mergeable,
              terminalChecks: [
                { externalId: "checkrun:1", name: "review", outcome: "green" },
              ],
            }),
            keymaxxer,
            opencodeWith(
              [
                "No review feedback needed changes.",
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
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED")
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: RERUN_REVIEW:")
    expect(prompts[1]).toContain(
      "Do not report PROCESSED for a present, positively identified, visibly incomplete automated review that still needs a whole-workflow rerun",
    )
    expect(prompts[1]).toContain(
      "including a skipped reviewer with no review output",
    )
    expect(prompts[1]).toContain(
      "genuinely completed review that had nothing to address",
    )
    expect(prompts[1]).toContain("no relevant automated-review run or comment")
    expect(prompts[1]).toContain(
      "successful terminal review with no relevant comment (no feedback)",
    )
    expect(prompts[1]).not.toContain("READY_FOR_AGENT_RESULT: WAITING")
    expect(prompts[1]).toContain(
      "technical or observability failure prevented you from determining the relevant review state",
    )
  })

  it("treats a successful terminal review with no relevant comment as PROCESSED no feedback", async () => {
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
              "Terminal successful review with no relevant comment; no feedback.",
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

  it("rejects removed WAITING verdicts", () => {
    expect(parseInvestigationResult("READY_FOR_AGENT_RESULT: WAITING")).toBe(
      null,
    )
  })

  it("parses CHECKS_TRIGGERED as a distinct valid result", () => {
    expect(
      parseInvestigationResult("READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED"),
    ).toBe("checks_triggered")
    expect(
      parseInvestigationResult(
        "notes\nREADY_FOR_AGENT_RESULT: CHECKS_TRIGGERED",
      ),
    ).toBe("checks_triggered")
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

  it("parses structured RERUN_REVIEW verdicts with optional workflow name", () => {
    expect(
      parseInvestigationResult(
        "READY_FOR_AGENT_RESULT: RERUN_REVIEW: 29906669357",
      ),
    ).toEqual({
      _tag: "rerun_review",
      workflowRunId: 29906669357,
      workflowName: null,
    })
    expect(
      parseInvestigationResult(
        "notes\nREADY_FOR_AGENT_RESULT: RERUN_REVIEW: 42 Claude Code Review",
      ),
    ).toEqual({
      _tag: "rerun_review",
      workflowRunId: 42,
      workflowName: "Claude Code Review",
    })
  })

  it("treats the production success+skipped name-only shape as a green-only PROCESSED no-op", async () => {
    const prompts: string[] = []
    let rerunCalls = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        return yield* investigatePrStatusChecks(context)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith(
              {
                _tag: "succeeded",
                ...mergeable,
                headSha: "sha-incident",
                terminalChecks: [
                  {
                    externalId: "actions-job:1",
                    name: "PR Review/main",
                    outcome: "green",
                  },
                ],
              },
              {
                rerunWorkflowRun: () => {
                  rerunCalls += 1
                  return Effect.void
                },
              },
            ),
            keymaxxer,
            opencodeWith(
              [
                "Claude review skipped; PR Review is ordinary CI; no review evidence.",
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
    expect(rerunCalls).toBe(0)
    expect(prompts[0]).toContain(
      'names containing "review" or "PR Review") are not positive review evidence',
    )
    expect(prompts[0]).toContain(
      "skipped workflow or job with no executed reviewer steps",
    )
  })

  it("authorizes exactly three whole-review reruns then Needs Human before a fourth", async () => {
    const rerunIds: number[] = []
    const headSha = "sha-review-head"
    const workflowRunId = 29906669357
    const greenStatus = {
      _tag: "succeeded" as const,
      ...mergeable,
      headSha,
      terminalChecks: [
        {
          externalId: "actions-job:review",
          name: "Claude Code Review/claude-review",
          outcome: "green" as const,
        },
      ],
    }
    // Each investigate needs its own OpenCode script (work + verdict).
    const opencodeOutputs = Array.from(
      { length: AUTOMATED_REVIEW_RERUN_LIMIT + 1 },
      () =>
        [
          "terminal incomplete review",
          `READY_FOR_AGENT_RESULT: RERUN_REVIEW: ${workflowRunId} Claude Code Review`,
        ] as const,
    ).flat()

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        const sql = yield* SqlClient.SqlClient
        for (
          let attempt = 1;
          attempt <= AUTOMATED_REVIEW_RERUN_LIMIT;
          attempt += 1
        ) {
          const now = Date.now()
          yield* sql.unsafe(
            `INSERT INTO pr_status_check (
               id, work_item_id, external_id, name, outcome,
               handled_at, observed_at, created_at, updated_at
             ) VALUES (?, ?, ?, 'Claude Code Review/claude-review', 'green', NULL, ?, ?, ?)`,
            [
              `psc-review-${attempt}`,
              context.workItemId,
              `actions-job:review-${attempt}`,
              now,
              now,
              now,
            ],
          )
          const result = yield* investigatePrStatusChecks(context)
          expect(result._tag).toBe("checks_triggered")
          if (result._tag === "checks_triggered") {
            expect(result.handledCheckIds).toEqual([`psc-review-${attempt}`])
            expect(result.checkStartAnchorRecorded).toBe(true)
            const handledAt = Date.now()
            for (const checkId of result.handledCheckIds) {
              yield* sql.unsafe(
                `UPDATE pr_status_check
                 SET handled_at = ?, updated_at = ?
                 WHERE id = ?`,
                [handledAt, handledAt, checkId],
              )
            }
          }
          const anchors = (yield* sql.unsafe(
            `SELECT check_start_anchor_at, check_start_anchor_head_sha
             FROM work_item WHERE id = ?`,
            [context.workItemId],
          )) as readonly {
            readonly check_start_anchor_at: number | null
            readonly check_start_anchor_head_sha: string | null
          }[]
          expect(anchors[0]?.check_start_anchor_at).not.toBeNull()
          expect(anchors[0]?.check_start_anchor_head_sha).toBe(headSha)
        }
        const now = Date.now()
        yield* sql.unsafe(
          `INSERT INTO pr_status_check (
             id, work_item_id, external_id, name, outcome,
             handled_at, observed_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'Claude Code Review/claude-review', 'green', NULL, ?, ?, ?)`,
          [
            "psc-review-4",
            context.workItemId,
            "actions-job:review-4",
            now,
            now,
            now,
          ],
        )
        const exhausted = yield* investigatePrStatusChecks(context)
        expect(exhausted).toEqual({
          _tag: "needs_human",
          reason: automatedReviewRerunLimitReason("Claude Code Review"),
          handledCheckIds: ["psc-review-4"],
        })
        const permits = (yield* sql.unsafe(
          `SELECT COUNT(*) AS count FROM automated_review_rerun
           WHERE work_item_id = ? AND head_sha = ? AND workflow_run_id = ?`,
          [context.workItemId, headSha, String(workflowRunId)],
        )) as readonly { readonly count: number }[]
        expect(Number(permits[0]?.count)).toBe(AUTOMATED_REVIEW_RERUN_LIMIT)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith(greenStatus, {
              rerunWorkflowRun: (_repo, runId) => {
                rerunIds.push(runId)
                return Effect.void
              },
            }),
            keymaxxer,
            opencodeWith(opencodeOutputs),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(rerunIds).toEqual([workflowRunId, workflowRunId, workflowRunId])
  })

  it("keeps a reserved permit when the GitHub rerun response is indeterminate", async () => {
    let rerunCalls = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          `UPDATE work_item
           SET check_start_anchor_at = 1234,
               check_start_anchor_head_sha = 'prior-head',
               updated_at = 1234
           WHERE id = ?`,
          [context.workItemId],
        )
        const investigation = yield* Effect.result(
          investigatePrStatusChecks(context),
        )
        const permits = (yield* sql.unsafe(
          `SELECT status FROM automated_review_rerun WHERE work_item_id = ?`,
          [context.workItemId],
        )) as readonly { readonly status: string }[]
        const anchors = (yield* sql.unsafe(
          `SELECT check_start_anchor_at, check_start_anchor_head_sha
           FROM work_item WHERE id = ?`,
          [context.workItemId],
        )) as readonly {
          readonly check_start_anchor_at: number | null
          readonly check_start_anchor_head_sha: string | null
        }[]
        return { investigation, permits, anchors }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith(
              {
                _tag: "succeeded",
                ...mergeable,
                headSha: "sha-indeterminate",
                terminalChecks: [
                  {
                    externalId: "actions-job:1",
                    name: "review",
                    outcome: "green",
                  },
                ],
              },
              {
                rerunWorkflowRun: () => {
                  rerunCalls += 1
                  return Effect.fail(
                    new GitHubRequestError({
                      message: "GitHub 502 while rerunning workflow",
                      statusCode: 502,
                    }),
                  )
                },
              },
            ),
            keymaxxer,
            opencodeWith([
              "need rerun",
              "READY_FOR_AGENT_RESULT: RERUN_REVIEW: 99 Review Bot",
            ]),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(rerunCalls).toBe(1)
    expect(result.investigation._tag).toBe("Failure")
    expect(result.permits).toEqual([{ status: "reserved" }])
    expect(result.anchors).toEqual([
      {
        check_start_anchor_at: 1234,
        check_start_anchor_head_sha: "prior-head",
      },
    ])
  })

  it("gives a new PR head a fresh automated-review rerun budget", async () => {
    const rerunIds: number[] = []
    const workflowRunId = 100
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        for (let i = 0; i < AUTOMATED_REVIEW_RERUN_LIMIT; i += 1) {
          yield* sql.unsafe(
            `INSERT INTO automated_review_rerun (
               id, work_item_id, head_sha, workflow_run_id, workflow_name,
               status, created_at, updated_at
             ) VALUES (?, ?, 'old-head', ?, 'Review', 'completed', ?, ?)`,
            [
              `arr-old-${i}`,
              context.workItemId,
              String(workflowRunId),
              now,
              now,
            ],
          )
        }
        yield* sql.unsafe(
          `INSERT INTO pr_status_check (
             id, work_item_id, external_id, name, outcome,
             handled_at, observed_at, created_at, updated_at
           ) VALUES ('psc-new-head', ?, 'actions-job:new', 'review', 'green', NULL, ?, ?, ?)`,
          [context.workItemId, now, now, now],
        )
        const result = yield* investigatePrStatusChecks(context)
        expect(result._tag).toBe("checks_triggered")
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith(
              {
                _tag: "succeeded",
                ...mergeable,
                headSha: "new-head",
                terminalChecks: [
                  {
                    externalId: "actions-job:new",
                    name: "review",
                    outcome: "green",
                  },
                ],
              },
              {
                rerunWorkflowRun: (_repo, runId) => {
                  rerunIds.push(runId)
                  return Effect.void
                },
              },
            ),
            keymaxxer,
            opencodeWith([
              "incomplete on new head",
              `READY_FOR_AGENT_RESULT: RERUN_REVIEW: ${workflowRunId}`,
            ]),
            DatabaseTest,
          ),
        ),
      ),
    )
    expect(rerunIds).toEqual([workflowRunId])
  })

  it("allows PROCESSED after human intervention even when the old rerun budget is exhausted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        for (let i = 0; i < AUTOMATED_REVIEW_RERUN_LIMIT; i += 1) {
          yield* sql.unsafe(
            `INSERT INTO automated_review_rerun (
               id, work_item_id, head_sha, workflow_run_id, workflow_name,
               status, created_at, updated_at
             ) VALUES (?, ?, 'sha-exhausted', '77', 'Claude Code Review', 'completed', ?, ?)`,
            [`arr-ex-${i}`, context.workItemId, now, now],
          )
        }
        yield* sql.unsafe(
          `INSERT INTO pr_status_check (
             id, work_item_id, external_id, name, outcome,
             handled_at, observed_at, created_at, updated_at
           ) VALUES ('psc-after-human', ?, 'actions-job:after', 'review', 'green', NULL, ?, ?, ?)`,
          [context.workItemId, now, now, now],
        )
        const result = yield* investigatePrStatusChecks(context)
        expect(result).toEqual({
          _tag: "processed",
          handledCheckIds: ["psc-after-human"],
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "succeeded",
              ...mergeable,
              headSha: "sha-exhausted",
              terminalChecks: [
                {
                  externalId: "actions-job:after",
                  name: "review",
                  outcome: "green",
                },
              ],
            }),
            keymaxxer,
            opencodeWith([
              "Human completed the review; nothing left to address.",
              "READY_FOR_AGENT_RESULT: PROCESSED",
            ]),
            DatabaseTest,
          ),
        ),
      ),
    )
  })

  it("does not consume review-rerun permits for ordinary PROCESSED outcomes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        yield* investigatePrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        const permits = (yield* sql.unsafe(
          `SELECT COUNT(*) AS count FROM automated_review_rerun WHERE work_item_id = ?`,
          [context.workItemId],
        )) as readonly { readonly count: number }[]
        expect(Number(permits[0]?.count)).toBe(0)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "succeeded",
              ...mergeable,
              headSha: "sha-noop",
              terminalChecks: [
                { externalId: "actions-job:1", name: "lint", outcome: "green" },
              ],
            }),
            keymaxxer,
            opencodeWith([
              "green-only no-op",
              "READY_FOR_AGENT_RESULT: PROCESSED",
            ]),
            DatabaseTest,
          ),
        ),
      ),
    )
  })

  it("still accepts PROCESSED after the review-rerun budget is exhausted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        const sql = yield* SqlClient.SqlClient
        const now = Date.now()
        for (let i = 0; i < AUTOMATED_REVIEW_RERUN_LIMIT; i += 1) {
          yield* sql.unsafe(
            `INSERT INTO automated_review_rerun (
               id, work_item_id, head_sha, workflow_run_id, workflow_name,
               status, created_at, updated_at
             ) VALUES (?, ?, 'sha-exhausted', '55', 'reviewer', 'completed', ?, ?)`,
            [`arr-ex-${i}`, context.workItemId, now, now],
          )
        }
        yield* sql.unsafe(
          `INSERT INTO pr_status_check (
             id, work_item_id, external_id, name, outcome,
             handled_at, observed_at, created_at, updated_at
           ) VALUES ('psc-after-human', ?, 'actions-job:done', 'reviewer', 'green', NULL, ?, ?, ?)`,
          [context.workItemId, now, now, now],
        )
        const result = yield* investigatePrStatusChecks(context)
        expect(result).toEqual({
          _tag: "processed",
          handledCheckIds: [expect.any(String)],
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "succeeded",
              ...mergeable,
              headSha: "sha-exhausted",
              terminalChecks: [],
            }),
            keymaxxer,
            opencodeWith([
              "Human finished the review; feedback addressed.",
              "READY_FOR_AGENT_RESULT: PROCESSED",
            ]),
            DatabaseTest,
          ),
        ),
      ),
    )
  })
})
