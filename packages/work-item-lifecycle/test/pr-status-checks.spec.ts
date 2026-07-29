import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  AgentBackend,
  AgentBackendExitError,
} from "@ready-for-agent/agent-backend"
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
  GitLabService,
  type GitLabServiceShape,
} from "@ready-for-agent/gitlab-service"
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
  stubActiveAgentBackendLayer,
  stubGrokActiveAgentBackendLayer,
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
  issueNumber: 42,
  issueTitle: null,
  agentBackend: "opencode",
  model: "opencode/test-model",
  thinkingLevel: "high",
  reviewModel: "opencode/test-model",
  reviewThinkingLevel: "high",
  worktreePath: "/tmp/worktree",
  startingCommitOid: null,
  completionSummary: null,

  publicationTitle: null,

  publicationBody: null,
  sessionId: "ses_implement",
}

const db = stubDbServiceLayer({
  listRepositories: Effect.succeed([repository]),
})
const gitlabRepository = makeRepositoryRecord({
  id: repository.id,
  forge: "gitlab",
  forgeHost: "git.drupalcode.org",
  projectPath: "project/oauth_client",
  localPath: "/repos/oauth_client",
})
const gitlabDb = stubDbServiceLayer({
  listRepositories: Effect.succeed([gitlabRepository]),
})

const keymaxxerService = Layer.succeed(KeymaxxerService, {
  initialize: Effect.void,
  hasSecret: () => Effect.succeed(true),
  findSecret: () => Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS"),
  findSecrets: () => Effect.succeed([]),
  addSecret: () => Effect.succeed(true),
  runWithSecrets: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
} satisfies KeymaxxerServiceShape)

/** Vault-enabled Keymaxxer plus capable (OpenCode) Active Agent Backend. */
const keymaxxer = Layer.mergeAll(
  keymaxxerService,
  stubActiveAgentBackendLayer(),
)

const keymaxxerDisabled = Layer.mergeAll(
  Layer.succeed(KeymaxxerService, {
    enabled: false,
    initialize: Effect.void,
    hasSecret: () => Effect.succeed(false),
    findSecret: () => Effect.die("must not inspect the vault"),
    findSecrets: () => Effect.succeed([]),
    addSecret: () => Effect.succeed(false),
    runWithSecrets: () =>
      Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
  } satisfies KeymaxxerServiceShape),
  stubActiveAgentBackendLayer(),
)

const seedWorkItem = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = Date.now()
  yield* sql.unsafe(
    `INSERT INTO repository (
       id, forge, forge_host, project_path, local_path, is_bare, paused,
       issues_reconciled_at, created_at, updated_at
     ) VALUES (?, 'github', 'github.com', 'acme/widgets', '/repos/widgets', 1, 0, NULL, ?, ?)`,
    [repository.id, now, now],
  )
  yield* sql.unsafe(
    `INSERT INTO work_item (
       id, repository_id, issue_number, state,
       state_ready_at, worktree_path, session_id, failure_code, failure_message,
       created_at, updated_at
      ) VALUES (?, ?, 42,
        'watch_pr_status_checks', ?, '/tmp/worktree', 'ses_implement', NULL, NULL, ?, ?)`,
    [context.workItemId, repository.id, now, now, now],
  )
})

const seedStatusCheck = (input: {
  readonly id: string
  readonly externalId: string
  readonly name: string
  readonly outcome: "green" | "red"
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = Date.now()
    yield* sql.unsafe(
      `INSERT INTO pr_status_check (
         id, work_item_id, external_id, name, outcome,
         handled_at, observed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        input.id,
        context.workItemId,
        input.externalId,
        input.name,
        input.outcome,
        now,
        now,
        now,
      ],
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
    findOpenPullRequestNumber: () => Effect.succeed(1),
    createDraftPullRequest: () => Effect.succeed(1),
    countOpenNonDraftPullRequests: () => Effect.succeed(0),
    getPullRequestCheckStatus: () => Effect.succeed(status),
    getPrStatusCheckDiagnostics: () => Effect.succeed([]),
    observeAutomatedReviewEvidence: () =>
      Effect.succeed({
        _tag: "ambiguous" as const,
        reason: "Automated review evidence observation is not configured",
      }),
    getPullRequestLifecycleStatus: () =>
      Effect.succeed({ _tag: "open" as const }),
    markPullRequestReadyForReview: () => Effect.void,
    mergePullRequest: () => Effect.succeed({ _tag: "merged" }),
    rerunWorkflowRun: () => Effect.void,
    ensureIssueCompletedWithSummary: () => Effect.void,
    ...overrides,
  } satisfies GitHubServiceShape)

const gitlabWith = (
  status: PullRequestCheckStatus,
  overrides: Partial<GitLabServiceShape> = {},
) =>
  Layer.succeed(GitLabService, {
    verifyProject: () => Effect.void,
    getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
    listReadyIssues: () => Effect.succeed([]),
    hasCredentials: () => Effect.succeed(true),
    hasAmbientCredentials: () => Effect.succeed(true),
    getOpenPullRequestNumber: () => Effect.succeed(1),
    findOpenPullRequestNumber: () => Effect.succeed(1),
    createDraftPullRequest: () => Effect.succeed(1),
    updateOpenDraftPullRequestCopy: () => Effect.succeed(1),
    countOpenNonDraftPullRequests: () => Effect.succeed(0),
    getPullRequestCheckStatus: () => Effect.succeed(status),
    getPrStatusCheckDiagnostics: () => Effect.succeed([]),
    markPullRequestReadyForReview: () => Effect.void,
    ensureIssueCompletedWithSummary: () => Effect.void,
    closeOpenPullRequestsForBranch: () => Effect.void,
    deleteBranch: () => Effect.void,
    ...overrides,
  } satisfies GitLabServiceShape)

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
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: (_repository, branch) => {
        requestedBranch = branch
        return Effect.succeed({
          _tag: "pending",
          terminalChecks: [],
          ...mergeable,
        })
      },
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
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

  it("defers unhandled green results while the aggregate is still pending", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        const status = yield* watchPrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        const rows = (yield* sql.unsafe(
          `SELECT external_id, outcome, handled_at
           FROM pr_status_check
           WHERE work_item_id = ?`,
          [context.workItemId],
        )) as readonly {
          readonly external_id: string
          readonly outcome: string
          readonly handled_at: number | null
        }[]
        return { status, rows }
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

    expect(result.status._tag).toBe("pending")
    expect(result.rows).toEqual([
      {
        external_id: "checkrun:1",
        outcome: "green",
        handled_at: null,
      },
    ])
  })

  it("hands off unhandled red results immediately while the aggregate is still pending", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        const status = yield* watchPrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        const rows = (yield* sql.unsafe(
          `SELECT external_id, outcome, handled_at
           FROM pr_status_check
           WHERE work_item_id = ?
           ORDER BY external_id`,
          [context.workItemId],
        )) as readonly {
          readonly external_id: string
          readonly outcome: string
          readonly handled_at: number | null
        }[]
        return { status, rows }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith({
              _tag: "pending",
              ...mergeable,
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

    expect(result.status._tag).toBe("handoff_needed")
    // Immediate red handoff still carries accumulated unhandled greens.
    expect(result.rows).toEqual([
      {
        external_id: "checkrun:1",
        outcome: "red",
        handled_at: null,
      },
      {
        external_id: "checkrun:2",
        outcome: "green",
        handled_at: null,
      },
    ])
  })

  it("hands off previously deferred greens when a red appears before the aggregate settles", async () => {
    const statuses: PullRequestCheckStatus[] = [
      {
        _tag: "pending",
        ...mergeable,
        terminalChecks: [
          { externalId: "checkrun:lint", name: "lint", outcome: "green" },
        ],
      },
      {
        _tag: "pending",
        ...mergeable,
        terminalChecks: [
          { externalId: "checkrun:lint", name: "lint", outcome: "green" },
          { externalId: "checkrun:unit", name: "unit", outcome: "red" },
        ],
      },
    ]
    let index = 0
    const github = Layer.succeed(GitHubService, {
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[1]!),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
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
        const first = yield* watchPrStatusChecks(context)
        const second = yield* watchPrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        const rows = (yield* sql.unsafe(
          `SELECT external_id, outcome, handled_at
           FROM pr_status_check
           WHERE work_item_id = ?
           ORDER BY external_id`,
          [context.workItemId],
        )) as readonly {
          readonly external_id: string
          readonly outcome: string
          readonly handled_at: number | null
        }[]
        return { first, second, rows }
      }).pipe(Effect.provide(Layer.mergeAll(db, github, DatabaseTest))),
    )

    expect(result.first._tag).toBe("pending")
    expect(result.second._tag).toBe("handoff_needed")
    expect(result.rows).toEqual([
      {
        external_id: "checkrun:lint",
        outcome: "green",
        handled_at: null,
      },
      {
        external_id: "checkrun:unit",
        outcome: "red",
        handled_at: null,
      },
    ])
  })

  it("batches staggered green results into one handoff after the aggregate settles", async () => {
    const statuses: PullRequestCheckStatus[] = [
      {
        _tag: "pending",
        ...mergeable,
        terminalChecks: [
          { externalId: "checkrun:lint", name: "lint", outcome: "green" },
        ],
      },
      {
        _tag: "pending",
        ...mergeable,
        terminalChecks: [
          { externalId: "checkrun:lint", name: "lint", outcome: "green" },
          {
            externalId: "checkrun:claude-review",
            name: "claude-review",
            outcome: "green",
          },
        ],
      },
      {
        _tag: "succeeded",
        ...mergeable,
        terminalChecks: [
          { externalId: "checkrun:lint", name: "lint", outcome: "green" },
          {
            externalId: "checkrun:claude-review",
            name: "claude-review",
            outcome: "green",
          },
          { externalId: "checkrun:main", name: "main", outcome: "green" },
        ],
      },
    ]
    let index = 0
    const github = Layer.succeed(GitHubService, {
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[2]!),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
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
        const first = yield* watchPrStatusChecks(context)
        const second = yield* watchPrStatusChecks(context)
        const third = yield* watchPrStatusChecks(context)
        const investigation = yield* investigatePrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        const rows = (yield* sql.unsafe(
          `SELECT external_id, name, outcome, handled_at
           FROM pr_status_check
           WHERE work_item_id = ?
           ORDER BY external_id`,
          [context.workItemId],
        )) as readonly {
          readonly external_id: string
          readonly name: string
          readonly outcome: string
          readonly handled_at: number | null
        }[]
        return { first, second, third, investigation, rows }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            github,
            keymaxxer,
            opencodeWith(["READY_FOR_AGENT_RESULT: PROCESSED"]),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result.first._tag).toBe("pending")
    expect(result.second._tag).toBe("pending")
    expect(result.third._tag).toBe("handoff_needed")
    expect(result.investigation._tag).toBe("processed")
    if (result.investigation._tag === "processed") {
      expect(result.investigation.handledCheckIds).toHaveLength(3)
    }
    expect(result.rows).toEqual([
      {
        external_id: "checkrun:claude-review",
        name: "claude-review",
        outcome: "green",
        handled_at: null,
      },
      {
        external_id: "checkrun:lint",
        name: "lint",
        outcome: "green",
        handled_at: null,
      },
      {
        external_id: "checkrun:main",
        name: "main",
        outcome: "green",
        handled_at: null,
      },
    ])
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
      {
        _tag: "succeeded",
        ...mergeable,
        terminalChecks: [
          { externalId: "checkrun:1", name: "review", outcome: "green" },
        ],
      },
    ]
    let index = 0
    const github = Layer.succeed(GitHubService, {
      getAuthenticatedUserLogin: () => Effect.succeed("test-operator"),
      listReadyIssues: () => Effect.succeed([]),
      getOpenPullRequestNumber: () => Effect.succeed(1),
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[2]!),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
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
        const stillPending = yield* watchPrStatusChecks(context)
        const settled = yield* watchPrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        const rows = (yield* sql.unsafe(
          `SELECT external_id, handled_at FROM pr_status_check WHERE work_item_id = ?`,
          [context.workItemId],
        )) as readonly {
          readonly external_id: string
          readonly handled_at: number | null
        }[]
        return { unknown, stillPending, settled, rows }
      }).pipe(Effect.provide(Layer.mergeAll(db, github, DatabaseTest))),
    )

    expect(result.unknown._tag).toBe("pending")
    expect(result.stillPending._tag).toBe("pending")
    expect(result.settled._tag).toBe("handoff_needed")
    expect(result.rows).toEqual([
      { external_id: "checkrun:1", handled_at: null },
    ])
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
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[1]!),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
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
      findOpenPullRequestNumber: () => Effect.succeed(1),
      createDraftPullRequest: () => Effect.succeed(1),
      countOpenNonDraftPullRequests: () => Effect.succeed(0),
      getPullRequestCheckStatus: () =>
        Effect.succeed(statuses[index++] ?? statuses[1]!),
      getPrStatusCheckDiagnostics: () => Effect.succeed([]),
      observeAutomatedReviewEvidence: () =>
        Effect.succeed({
          _tag: "ambiguous" as const,
          reason: "Automated review evidence observation is not configured",
        }),
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

  it("processes a red batch in one combined work and outcome turn", async () => {
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
                observeAutomatedReviewEvidence: () =>
                  Effect.succeed({
                    _tag: "ambiguous" as const,
                    reason:
                      "Automated review evidence observation is not configured",
                  }),
              },
            ),
            keymaxxer,
            opencodeWith(
              ["fixed and pushed\nREADY_FOR_AGENT_RESULT: CHECKS_TRIGGERED"],
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
    expect(prompts).toHaveLength(1)
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
    expect(prompts[0]).toContain("READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED")
    expect(prompts[0]).toContain("READY_FOR_AGENT_RESULT: PROCESSED")
    expect(prompts[0]).toContain("READY_FOR_AGENT_RESULT: FAILED:")
    expect(prompts[0]).toContain(
      "If this handoff contained red checks and you made no commit, push, check restart",
    )
    expect(prompts[0]).toContain("replacement check executions")
    const credentialIndex = prompts[0].indexOf(
      "Use Keymaxxer secret GITHUB_TOKEN_ACME_WIDGETS via keymaxxer_run",
    )
    const outcomeContractIndex = prompts[0].indexOf(
      "End your final response with exactly one machine-readable result line:",
    )
    expect(credentialIndex).toBeGreaterThan(-1)
    expect(outcomeContractIndex).toBeGreaterThan(credentialIndex)
  })

  it("uses ambient gh guidance for investigate when the backend lacks KeymaxxerMcp", async () => {
    const prompts: string[] = []
    let findSecretCalled = false
    const vaultOnWithoutLookup = Layer.mergeAll(
      Layer.succeed(KeymaxxerService, {
        initialize: Effect.void,
        hasSecret: () => Effect.succeed(true),
        findSecret: () => {
          findSecretCalled = true
          return Effect.succeed("GITHUB_TOKEN_ACME_WIDGETS")
        },
        findSecrets: () => Effect.succeed([]),
        addSecret: () => Effect.succeed(true),
        runWithSecrets: () =>
          Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      } satisfies KeymaxxerServiceShape),
      stubGrokActiveAgentBackendLayer,
    )
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
            vaultOnWithoutLookup,
            opencodeWith(
              ["fixed and pushed\nREADY_FOR_AGENT_RESULT: CHECKS_TRIGGERED"],
              (prompt) => prompts.push(prompt),
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result._tag).toBe("checks_triggered")
    expect(findSecretCalled).toBe(false)
    expect(prompts[0]?.toLowerCase()).not.toContain("keymaxxer")
    expect(prompts[0]).toContain(
      "Use the gh CLI with the existing ambient authentication",
    )
  })

  it("uses GitLab curl/glab credential guidance for investigate and never mentions gh", async () => {
    const prompts: string[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* seedStatusCheck({
          id: "psc-gitlab-lint",
          externalId: "gitlab-job:1",
          name: "lint",
          outcome: "red",
        })
        return yield* investigatePrStatusChecks(context)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            gitlabDb,
            githubWith(
              {
                _tag: "failed",
                ...mergeable,
                terminalChecks: [],
              },
              {
                getPullRequestCheckStatus: () =>
                  Effect.die("must not inspect GitHub status"),
                getPrStatusCheckDiagnostics: () =>
                  Effect.die("must not inspect GitHub diagnostics"),
                observeAutomatedReviewEvidence: () =>
                  Effect.die("must not inspect GitHub review evidence"),
                rerunWorkflowRun: () =>
                  Effect.die("must not rerun a GitHub workflow"),
              },
            ),
            gitlabWith(
              {
                _tag: "failed",
                ...mergeable,
                terminalChecks: [
                  {
                    externalId: "gitlab-job:1",
                    name: "lint",
                    outcome: "red",
                  },
                ],
              },
              {
                getPrStatusCheckDiagnostics: () =>
                  Effect.succeed([
                    {
                      externalId: "gitlab-job:1",
                      name: "lint",
                      source: "gitlab-job" as const,
                      htmlUrl:
                        "https://git.drupalcode.org/project/oauth_client/-/jobs/1",
                      logFetch: {
                        _tag: "ok" as const,
                        excerpt: "ERROR: lint failed",
                        localPath: null,
                      },
                    },
                  ]),
              },
            ),
            keymaxxerDisabled,
            opencodeWith(
              ["fixed and pushed\nREADY_FOR_AGENT_RESULT: CHECKS_TRIGGERED"],
              (prompt) => prompts.push(prompt),
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result._tag).toBe("checks_triggered")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("GitLab pipeline-job traces")
    expect(prompts[0]).toContain("ERROR: lint failed")
    expect(prompts[0]).toContain("curl")
    expect(prompts[0]).toContain("https://git.drupalcode.org/api/v4")
    expect(prompts[0]).toContain("GITLAB_TOKEN")
    expect(prompts[0]).toContain("PRIVATE-TOKEN")
    expect(prompts[0]).toContain("glab")
    expect(prompts[0]).not.toMatch(/\bgh\b/i)
    expect(prompts[0]).not.toContain("GitHub")
  })

  it("watches GitLab head-pipeline jobs without querying GitHub", async () => {
    let githubCalled = false
    let gitlabBranch = ""
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        return yield* watchPrStatusChecks(context)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            gitlabDb,
            githubWith(
              {
                _tag: "pending",
                ...mergeable,
                terminalChecks: [],
              },
              {
                getPullRequestCheckStatus: () => {
                  githubCalled = true
                  return Effect.die("must not query GitHub")
                },
              },
            ),
            gitlabWith(
              {
                _tag: "failed",
                ...mergeable,
                isDraft: true,
                headSha: "abc123",
                terminalChecks: [
                  {
                    externalId: "gitlab-job:9",
                    name: "phpunit",
                    outcome: "red",
                  },
                  {
                    externalId: "gitlab-job:10",
                    name: "lint",
                    outcome: "green",
                  },
                ],
              },
              {
                getPullRequestCheckStatus: (_repository, branch) => {
                  gitlabBranch = branch
                  return Effect.succeed({
                    _tag: "failed" as const,
                    ...mergeable,
                    isDraft: true,
                    headSha: "abc123",
                    terminalChecks: [
                      {
                        externalId: "gitlab-job:9",
                        name: "phpunit",
                        outcome: "red" as const,
                      },
                      {
                        externalId: "gitlab-job:10",
                        name: "lint",
                        outcome: "green" as const,
                      },
                    ],
                  })
                },
              },
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(githubCalled).toBe(false)
    expect(gitlabBranch).toContain("project-oauth-client")
    expect(status._tag).toBe("handoff_needed")
    expect(status.isDraft).toBe(true)
  })

  it("completes a GitLab green-only handoff without an Agent Turn", async () => {
    let continueCalled = false
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* seedStatusCheck({
          id: "psc-gitlab-green",
          externalId: "gitlab-job:3",
          name: "lint",
          outcome: "green",
        })
        return yield* investigatePrStatusChecks(context)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            gitlabDb,
            githubWith(
              {
                _tag: "succeeded",
                ...mergeable,
                terminalChecks: [],
              },
              {
                observeAutomatedReviewEvidence: () =>
                  Effect.die("must not observe GitHub review evidence"),
              },
            ),
            gitlabWith({
              _tag: "succeeded",
              ...mergeable,
              terminalChecks: [
                {
                  externalId: "gitlab-job:3",
                  name: "lint",
                  outcome: "green",
                },
              ],
            }),
            keymaxxerDisabled,
            opencodeWith([], () => {
              continueCalled = true
            }),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result).toMatchObject({
      _tag: "processed",
      reasonNote: "green-no-review-evidence",
    })
    expect(continueCalled).toBe(false)
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
                "No code changes, commit, push, or PR comment were made.\nREADY_FOR_AGENT_RESULT: FAILED: ActionLint failed on GitHub 503",
                "Reran the failed workflow; a replacement execution is queued.\nREADY_FOR_AGENT_RESULT: CHECKS_TRIGGERED",
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
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain("READY_FOR_AGENT_RESULT: FAILED:")
    expect(prompts[1]).toContain("focused recovery attempt")
    expect(prompts[1]).toContain("ActionLint failed on GitHub 503")
    expect(prompts[1]).toContain("process the PR Status Check Handoff")
    expect(prompts[1]).toContain("retry the failed inspection")
    expect(prompts[1]).toContain("Do not create an empty or no-op commit")
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED")
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: FAILED:")
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
              "No safe action was available.\nREADY_FOR_AGENT_RESULT: FAILED: ActionLint failed on GitHub 503",
              "I checked the current PR and cannot safely restart or change it.\nREADY_FOR_AGENT_RESULT: FAILED: No autonomous recovery action remains",
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

  it("names Grok Build in investigate failure copy when that backend is captured", async () => {
    const grokContext: LifecycleStepContext = {
      ...context,
      agentBackend: "grok",
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(grokContext)
        return yield* Effect.result(investigatePrStatusChecks(grokContext))
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
            Layer.succeed(
              AgentBackend,
              AgentBackend.of({
                startTurn: () => Effect.die("unused"),
                continueTurn: () =>
                  Effect.fail(
                    new AgentBackendExitError({
                      exitCode: 1,
                      cwd: "/tmp/worktree",
                    }),
                  ),
                inspect: () =>
                  Effect.succeed({
                    backend: { id: "grok" as const, label: "Grok Build" },
                    models: [],
                  }),
              }),
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      const message = String(result.failure)
      expect(message).toContain(
        "Grok Build failed while investigating PR status checks (work)",
      )
      expect(message).not.toContain("OpenCode failed")
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
              ["done\nREADY_FOR_AGENT_RESULT: PROCESSED"],
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
                "No review feedback needed changes.\nREADY_FOR_AGENT_RESULT: PROCESSED",
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
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED")
    expect(prompts[0]).toContain("READY_FOR_AGENT_RESULT: RERUN_REVIEW:")
    expect(prompts[0]).toContain(
      "Do not report PROCESSED for a present, positively identified, visibly incomplete automated review that still needs a whole-workflow rerun",
    )
    expect(prompts[0]).toContain(
      "including a skipped reviewer with no review output",
    )
    expect(prompts[0]).toContain(
      "genuinely completed review that had nothing to address",
    )
    expect(prompts[0]).toContain("no relevant automated-review run or comment")
    expect(prompts[0]).toContain(
      "successful terminal review with no relevant comment (no feedback)",
    )
    expect(prompts[0]).not.toContain("READY_FOR_AGENT_RESULT: WAITING")
    expect(prompts[0]).toContain(
      "technical or observability failure prevented you from determining the relevant review state",
    )
  })

  it("processes ordinary green CI with no review evidence without an Agent Turn", async () => {
    let agentCalls = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedWorkItem
        yield* watchPrStatusChecks(context)
        const investigation = yield* investigatePrStatusChecks(context)
        const sql = yield* SqlClient.SqlClient
        // Simulate lifecycle marking checks handled from the investigation result.
        if (investigation._tag === "processed") {
          const now = Date.now()
          for (const id of investigation.handledCheckIds) {
            yield* sql.unsafe(
              `UPDATE pr_status_check
               SET handled_at = ?, updated_at = ?
               WHERE id = ?`,
              [now, now, id],
            )
          }
        }
        const rows = (yield* sql.unsafe(
          `SELECT external_id, handled_at FROM pr_status_check
           WHERE work_item_id = ? ORDER BY external_id`,
          [context.workItemId],
        )) as readonly {
          readonly external_id: string
          readonly handled_at: number | null
        }[]
        // Restart coverage: a second investigate must not re-open handled checks.
        const second = yield* investigatePrStatusChecks(context)
        return { investigation, rows, second }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            githubWith(
              {
                _tag: "succeeded",
                ...mergeable,
                terminalChecks: [
                  {
                    externalId: "actions-job:1",
                    name: "lint",
                    outcome: "green",
                  },
                  {
                    externalId: "actions-job:2",
                    name: "test",
                    outcome: "green",
                  },
                ],
              },
              {
                observeAutomatedReviewEvidence: () =>
                  Effect.succeed({
                    _tag: "none" as const,
                    reason: "green-no-review-evidence" as const,
                  }),
              },
            ),
            keymaxxer,
            opencodeWith(["should not run"], () => {
              agentCalls += 1
            }),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(agentCalls).toBe(0)
    expect(result.investigation).toEqual({
      _tag: "processed",
      handledCheckIds: [expect.any(String), expect.any(String)],
      reasonCode: "green-no-review-evidence",
      reasonNote: "green-no-review-evidence",
    })
    expect(result.rows.every((row) => row.handled_at !== null)).toBe(true)
    expect(result.second).toEqual({
      _tag: "processed",
      handledCheckIds: [],
    })
  })

  it("does not treat a successful workflow named like review as positive evidence", async () => {
    let agentCalls = 0
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
                terminalChecks: [
                  {
                    externalId: "actions-job:10",
                    name: "PR Review/main",
                    outcome: "green",
                  },
                ],
              },
              {
                observeAutomatedReviewEvidence: () =>
                  Effect.succeed({
                    _tag: "none" as const,
                    reason: "green-no-review-evidence" as const,
                  }),
              },
            ),
            keymaxxer,
            opencodeWith(["should not run"], () => {
              agentCalls += 1
            }),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(agentCalls).toBe(0)
    expect(result._tag).toBe("processed")
    if (result._tag === "processed") {
      expect(result.reasonCode).toBe("green-no-review-evidence")
    }
  })

  it("does not treat a skipped zero-step recognized reviewer as positive evidence", async () => {
    let agentCalls = 0
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
                terminalChecks: [
                  {
                    externalId: "actions-job:20",
                    name: "Claude Code Review/claude-review",
                    outcome: "green",
                  },
                  {
                    externalId: "actions-job:21",
                    name: "PR Review/main",
                    outcome: "green",
                  },
                ],
              },
              {
                observeAutomatedReviewEvidence: () =>
                  Effect.succeed({
                    _tag: "none" as const,
                    reason: "green-no-review-evidence" as const,
                  }),
              },
            ),
            keymaxxer,
            opencodeWith(["should not run"], () => {
              agentCalls += 1
            }),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(agentCalls).toBe(0)
    expect(result._tag).toBe("processed")
    if (result._tag === "processed") {
      expect(result.reasonNote).toBe("green-no-review-evidence")
    }
  })

  it("uses the Agent Turn when a recognized reviewer executed without a comment", async () => {
    let agentCalls = 0
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
                terminalChecks: [
                  {
                    externalId: "actions-job:30",
                    name: "Claude Code Review/claude-review",
                    outcome: "green",
                  },
                ],
              },
              {
                observeAutomatedReviewEvidence: () =>
                  Effect.succeed({
                    _tag: "positive" as const,
                    kind: "executed_reviewer_job" as const,
                    detail:
                      "Executed recognized reviewer job Claude Code Review/claude-review",
                  }),
              },
            ),
            keymaxxer,
            opencodeWith(
              [
                "No comment means no feedback.\nREADY_FOR_AGENT_RESULT: PROCESSED",
              ],
              () => {
                agentCalls += 1
              },
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(agentCalls).toBe(1)
    expect(result).toEqual({
      _tag: "processed",
      handledCheckIds: [expect.any(String)],
    })
  })

  it("uses the Agent Turn when a recognized automated-review comment exists", async () => {
    let agentCalls = 0
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
                terminalChecks: [
                  {
                    externalId: "actions-job:40",
                    name: "lint",
                    outcome: "green",
                  },
                ],
              },
              {
                observeAutomatedReviewEvidence: () =>
                  Effect.succeed({
                    _tag: "positive" as const,
                    kind: "review_comment" as const,
                    detail: "Issue comment from claude[bot]",
                  }),
              },
            ),
            keymaxxer,
            opencodeWith(
              ["Addressed review feedback.\nREADY_FOR_AGENT_RESULT: PROCESSED"],
              () => {
                agentCalls += 1
              },
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(agentCalls).toBe(1)
    expect(result._tag).toBe("processed")
  })

  it("fails safe into the Agent Turn when evidence observation is ambiguous", async () => {
    let agentCalls = 0
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
                terminalChecks: [
                  {
                    externalId: "actions-job:50",
                    name: "lint",
                    outcome: "green",
                  },
                ],
              },
              {
                observeAutomatedReviewEvidence: () =>
                  Effect.succeed({
                    _tag: "ambiguous" as const,
                    reason: "GitHub rate limited",
                  }),
              },
            ),
            keymaxxer,
            opencodeWith(
              ["Inspected; ordinary CI.\nREADY_FOR_AGENT_RESULT: PROCESSED"],
              () => {
                agentCalls += 1
              },
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(agentCalls).toBe(1)
    expect(result._tag).toBe("processed")
  })

  it("never takes the green-only fast path when the handoff contains a red check", async () => {
    let observeCalls = 0
    let agentCalls = 0
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
                _tag: "failed",
                ...mergeable,
                terminalChecks: [
                  {
                    externalId: "actions-job:60",
                    name: "lint",
                    outcome: "red",
                  },
                  {
                    externalId: "actions-job:61",
                    name: "test",
                    outcome: "green",
                  },
                ],
              },
              {
                observeAutomatedReviewEvidence: () => {
                  observeCalls += 1
                  return Effect.succeed({
                    _tag: "none" as const,
                    reason: "green-no-review-evidence" as const,
                  })
                },
              },
            ),
            keymaxxer,
            opencodeWith(
              ["Fixed lint.\nREADY_FOR_AGENT_RESULT: CHECKS_TRIGGERED"],
              () => {
                agentCalls += 1
              },
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(observeCalls).toBe(0)
    expect(agentCalls).toBe(1)
    expect(result).toEqual({
      _tag: "checks_triggered",
      handledCheckIds: [expect.any(String), expect.any(String)],
      checkStartAnchorRecorded: false,
    })
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
              "Terminal successful review with no relevant comment; no feedback.\nREADY_FOR_AGENT_RESULT: PROCESSED",
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
              "investigated\nREADY_FOR_AGENT_RESULT: NEEDS_HUMAN: A maintainer must approve deployment",
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

  it("resolves a merge conflict in one combined work and outcome turn", async () => {
    const prompts: string[] = []
    const result = await Effect.runPromise(
      resolvePrMergeConflict(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            keymaxxer,
            opencodeWith(
              [
                "rebased, verified, and pushed\nREADY_FOR_AGENT_RESULT: PROCESSED",
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
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("Fetch origin")
    expect(prompts[0]).toContain("current base branch")
    expect(prompts[0]).toContain("every current remote commit")
    expect(prompts[0]).toContain("--force-with-lease")
    expect(prompts[0]).toContain("exactly once")
    expect(prompts[0]).toContain(
      "Use Keymaxxer secret GITHUB_TOKEN_ACME_WIDGETS via keymaxxer_run",
    )
    expect(prompts[0]).toContain("READY_FOR_AGENT_RESULT: PROCESSED")
    expect(prompts[0]).toContain("READY_FOR_AGENT_RESULT: NEEDS_HUMAN:")
  })

  it("uses ambient gh guidance for merge-conflict when Keymaxxer is disabled", async () => {
    const prompts: string[] = []
    const result = await Effect.runPromise(
      resolvePrMergeConflict(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            keymaxxerDisabled,
            opencodeWith(
              [
                "rebased, verified, and pushed\nREADY_FOR_AGENT_RESULT: PROCESSED",
              ],
              (prompt) => prompts.push(prompt),
            ),
          ),
        ),
      ),
    )

    expect(result).toEqual({ _tag: "processed" })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.toLowerCase()).not.toContain("keymaxxer")
    expect(prompts[0]).toContain(
      "Use the gh CLI with the existing ambient authentication",
    )
  })

  it("returns the merge-conflict resolver's human intervention reason", async () => {
    const result = await Effect.runPromise(
      resolvePrMergeConflict(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            keymaxxer,
            opencodeWith([
              "the second lease-protected push was rejected\nREADY_FOR_AGENT_RESULT: NEEDS_HUMAN: The PR branch changed during both push attempts",
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

  it("uses one classification fallback when the work turn omits the outcome", async () => {
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
                "fixed and pushed; replacement checks should run",
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
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain(
      "Based only on the PR status-check work you just did",
    )
    expect(prompts[1]).toContain("READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED")
  })

  it("uses one classification fallback when recovery omits the outcome", async () => {
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
    expect(prompts).toHaveLength(3)
    expect(prompts[1]).toContain("focused recovery attempt")
    expect(prompts[2]).toContain(
      "Based only on the PR status-check work you just did",
    )
  })

  it("uses one classification fallback when merge-conflict work omits the outcome", async () => {
    const prompts: string[] = []
    const result = await Effect.runPromise(
      resolvePrMergeConflict(context).pipe(
        Effect.provide(
          Layer.mergeAll(
            db,
            keymaxxer,
            opencodeWith(
              [
                "rebased, verified, and pushed with lease",
                "READY_FOR_AGENT_RESULT: PROCESSED",
              ],
              (prompt) => prompts.push(prompt),
            ),
          ),
        ),
      ),
    )

    expect(result).toEqual({ _tag: "processed" })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain(
      "Based only on the PR merge-conflict resolution work you just did",
    )
  })

  it("rejects malformed merge-conflict outcomes without a fallback turn", async () => {
    const prompts: string[] = []
    const result = await Effect.runPromise(
      Effect.result(
        resolvePrMergeConflict(context).pipe(
          Effect.provide(
            Layer.mergeAll(
              db,
              keymaxxer,
              opencodeWith(
                ["READY_FOR_AGENT_RESULT: NOT_A_REAL_OUTCOME"],
                (prompt) => prompts.push(prompt),
              ),
            ),
          ),
        ),
      ),
    )

    expect(result._tag).toBe("Failure")
    expect(prompts).toHaveLength(1)
  })

  it("rejects non-final merge-conflict outcomes without a fallback turn", async () => {
    const prompts: string[] = []
    const result = await Effect.runPromise(
      Effect.result(
        resolvePrMergeConflict(context).pipe(
          Effect.provide(
            Layer.mergeAll(
              db,
              keymaxxer,
              opencodeWith(
                [
                  "READY_FOR_AGENT_RESULT: PROCESSED\nmore prose after the marker",
                ],
                (prompt) => prompts.push(prompt),
              ),
            ),
          ),
        ),
      ),
    )

    expect(result._tag).toBe("Failure")
    expect(prompts).toHaveLength(1)
  })

  it("rejects conflicting merge-conflict outcomes without a fallback turn", async () => {
    const prompts: string[] = []
    const result = await Effect.runPromise(
      Effect.result(
        resolvePrMergeConflict(context).pipe(
          Effect.provide(
            Layer.mergeAll(
              db,
              keymaxxer,
              opencodeWith(
                [
                  [
                    "READY_FOR_AGENT_RESULT: PROCESSED",
                    "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: approval required",
                  ].join("\n"),
                ],
                (prompt) => prompts.push(prompt),
              ),
            ),
          ),
        ),
      ),
    )

    expect(result._tag).toBe("Failure")
    expect(prompts).toHaveLength(1)
  })

  it("leaves checks unhandled after a missing outcome and failed fallback", async () => {
    const prompts: string[] = []
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
            opencodeWith(["fixed", "I forgot the marker"], (prompt) =>
              prompts.push(prompt),
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result.investigation._tag).toBe("Failure")
    expect(result.observed.every((row) => row.handled_at === null)).toBe(true)
    expect(prompts).toHaveLength(2)
  })

  it("rejects malformed outcome markers without a fallback turn", async () => {
    const prompts: string[] = []
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
            opencodeWith(
              ["READY_FOR_AGENT_RESULT: NOT_A_REAL_OUTCOME"],
              (prompt) => prompts.push(prompt),
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result.investigation._tag).toBe("Failure")
    expect(result.observed.every((row) => row.handled_at === null)).toBe(true)
    expect(prompts).toHaveLength(1)
  })

  it("rejects non-final outcome markers without a fallback turn", async () => {
    const prompts: string[] = []
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
            opencodeWith(
              [
                "READY_FOR_AGENT_RESULT: PROCESSED\nmore prose after the marker",
              ],
              (prompt) => prompts.push(prompt),
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result.investigation._tag).toBe("Failure")
    expect(result.observed.every((row) => row.handled_at === null)).toBe(true)
    expect(prompts).toHaveLength(1)
  })

  it("rejects conflicting verdict markers without a fallback turn", async () => {
    const prompts: string[] = []
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
            opencodeWith(
              [
                [
                  "READY_FOR_AGENT_RESULT: PROCESSED",
                  "READY_FOR_AGENT_RESULT: NEEDS_HUMAN: approval required",
                ].join("\n"),
              ],
              (prompt) => prompts.push(prompt),
            ),
            DatabaseTest,
          ),
        ),
      ),
    )

    expect(result.investigation._tag).toBe("Failure")
    expect(result.observed.every((row) => row.handled_at === null)).toBe(true)
    expect(prompts).toHaveLength(1)
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
                "Claude review skipped; PR Review is ordinary CI; no review evidence.\nREADY_FOR_AGENT_RESULT: PROCESSED",
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
    // Each investigate needs its own OpenCode script (combined work + outcome).
    const opencodeOutputs = Array.from(
      { length: AUTOMATED_REVIEW_RERUN_LIMIT + 1 },
      () =>
        `terminal incomplete review\nREADY_FOR_AGENT_RESULT: RERUN_REVIEW: ${workflowRunId} Claude Code Review`,
    )

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
              "need rerun\nREADY_FOR_AGENT_RESULT: RERUN_REVIEW: 99 Review Bot",
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
              `incomplete on new head\nREADY_FOR_AGENT_RESULT: RERUN_REVIEW: ${workflowRunId}`,
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
              "Human completed the review; nothing left to address.\nREADY_FOR_AGENT_RESULT: PROCESSED",
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
              "green-only no-op\nREADY_FOR_AGENT_RESULT: PROCESSED",
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
              "Human finished the review; feedback addressed.\nREADY_FOR_AGENT_RESULT: PROCESSED",
            ]),
            DatabaseTest,
          ),
        ),
      ),
    )
  })
})
