import {
  CLI_SCHEMA_VERSION,
  FiniteCommandFailed,
  buildAddSuccessDocument,
  buildCandidatesSuccessDocument,
  buildCommandErrorDocument,
  buildIntakeSuccessDocument,
  buildRetrySuccessDocument,
  buildStatusSuccessDocument,
  encodeCompactJson,
  intakeHasFailedResults,
  localGitErrorCode,
  retryHasFailedResults,
} from "./cli-json.ts"
import { describe, expect, test } from "bun:test"

describe("finite CLI JSON contract", () => {
  test("add success document is compact camelCase with canonical repository", () => {
    const doc = buildAddSuccessDocument({
      id: "repo-1",
      forge: "github",
      forgeHost: "github.com",
      projectPath: "owner/repo",
      localPath: "/tmp/repo",
      isBare: false,
    })
    expect(doc).toEqual({
      schemaVersion: CLI_SCHEMA_VERSION,
      command: "add",
      repository: {
        id: "repo-1",
        forge: "github",
        forgeHost: "github.com",
        projectPath: "owner/repo",
      },
      localPath: "/tmp/repo",
      isBare: false,
    })
    expect(encodeCompactJson(doc)).toBe(
      '{"schemaVersion":1,"command":"add","repository":{"id":"repo-1","forge":"github","forgeHost":"github.com","projectPath":"owner/repo"},"localPath":"/tmp/repo","isBare":false}',
    )
  })

  test("status success document includes six lanes and null repository", () => {
    const doc = buildStatusSuccessDocument({
      repository: null,
      lanes: [
        {
          id: "QUEUE",
          label: "Queue",
          count: 1,
          workItems: [
            {
              repository: {
                id: "repo-1",
                forge: "github",
                forgeHost: "github.com",
                projectPath: "owner/repo",
              },
              id: "wi-1",
              issueNumber: 102,
              issueTitle: "Blocked follow-up",
              state: "CREATE_WORKTREE",
              status: "WAITING_FOR_BLOCKERS",
              statusMessage: "Waiting for blocking Issues",
              paused: false,
              canRetry: false,
              latestStepRunReason: null,
              pullRequestNumber: null,
              createdAt: "2026-08-12T10:00:00.000Z",
              updatedAt: "2026-08-12T10:00:00.000Z",
              stateReadyAt: "2026-08-12T10:00:00.000Z",
              postponedUntil: null,
            },
          ],
        },
        { id: "BUILD", label: "Build", count: 0, workItems: [] },
        { id: "REVIEW", label: "Review", count: 0, workItems: [] },
        { id: "PR", label: "PR", count: 0, workItems: [] },
        { id: "ATTENTION", label: "Attention", count: 0, workItems: [] },
        { id: "MERGED", label: "Merged", count: 0, workItems: [] },
      ],
    })
    expect(doc.schemaVersion).toBe(1)
    expect(doc.command).toBe("status")
    expect(doc.repository).toBeNull()
    expect(doc.lanes).toHaveLength(6)
    expect(doc.lanes[0]?.workItems[0]?.pullRequestNumber).toBeNull()
    expect(doc.lanes[0]?.workItems[0]?.canRetry).toBe(false)
    expect(doc.lanes[0]?.workItems[0]?.latestStepRunReason).toBeNull()
    expect(encodeCompactJson(doc)).toContain('"command":"status"')
    expect(encodeCompactJson(doc)).toContain('"pullRequestNumber":null')
    expect(encodeCompactJson(doc)).toContain('"canRetry":false')
  })

  test("status rows carry canRetry and latest Step Run reason additively on schemaVersion 1", () => {
    const doc = buildStatusSuccessDocument({
      repository: null,
      lanes: [
        {
          id: "ATTENTION",
          label: "Attention",
          count: 4,
          workItems: [
            {
              repository: {
                id: "repo-1",
                forge: "github",
                forgeHost: "github.com",
                projectPath: "owner/repo",
              },
              id: "wi-retryable-failed",
              issueNumber: 10,
              issueTitle: "Retryable implement failure",
              state: "IMPLEMENT",
              status: "FAILED",
              statusMessage:
                "Claude Code failed to implement the Work Item issue",
              paused: false,
              canRetry: true,
              latestStepRunReason: {
                code: "handler_failed",
                message: "Claude Code failed to implement the Work Item issue",
                detail: {
                  code: "ENOENT",
                  causeChain: [
                    {
                      name: "Error",
                      code: "ENOENT",
                      message:
                        'ENOENT: Executable not found in $PATH: "claude"',
                    },
                  ],
                },
              },
              pullRequestNumber: null,
              createdAt: "2026-08-12T10:00:00.000Z",
              updatedAt: "2026-08-12T10:00:00.000Z",
              stateReadyAt: "2026-08-12T10:00:00.000Z",
              postponedUntil: null,
            },
            {
              repository: {
                id: "repo-1",
                forge: "github",
                forgeHost: "github.com",
                projectPath: "owner/repo",
              },
              id: "wi-terminal-failed",
              issueNumber: 11,
              issueTitle: "Terminal close failure",
              state: "FAILED",
              status: "FAILED",
              statusMessage: "Issue is not open",
              paused: false,
              canRetry: false,
              latestStepRunReason: {
                code: "issue_not_open",
                message: "Issue is not open",
                detail: null,
              },
              pullRequestNumber: null,
              createdAt: "2026-08-12T10:00:00.000Z",
              updatedAt: "2026-08-12T10:00:00.000Z",
              stateReadyAt: "2026-08-12T10:00:00.000Z",
              postponedUntil: null,
            },
            {
              repository: {
                id: "repo-1",
                forge: "github",
                forgeHost: "github.com",
                projectPath: "owner/repo",
              },
              id: "wi-retryable-needs-human",
              issueNumber: 12,
              issueTitle: "Retryable review handoff",
              state: "NEEDS_HUMAN",
              status: "NEEDS_HUMAN",
              statusMessage: "Human must review findings",
              paused: false,
              canRetry: true,
              latestStepRunReason: {
                code: "review_accepted",
                message: "Human must review findings",
                detail: null,
              },
              pullRequestNumber: null,
              createdAt: "2026-08-12T10:00:00.000Z",
              updatedAt: "2026-08-12T10:00:00.000Z",
              stateReadyAt: "2026-08-12T10:00:00.000Z",
              postponedUntil: null,
            },
            {
              repository: {
                id: "repo-1",
                forge: "github",
                forgeHost: "github.com",
                projectPath: "owner/repo",
              },
              id: "wi-unavailable-detail",
              issueNumber: 13,
              issueTitle: "Interrupted without detail",
              state: "IMPLEMENT",
              status: "INTERRUPTED",
              statusMessage:
                "Lifecycle Step was interrupted before an outcome could be established",
              paused: false,
              canRetry: true,
              latestStepRunReason: {
                code: "interrupted",
                message:
                  "Lifecycle Step was interrupted before an outcome could be established",
                detail: null,
              },
              pullRequestNumber: null,
              createdAt: "2026-08-12T10:00:00.000Z",
              updatedAt: "2026-08-12T10:00:00.000Z",
              stateReadyAt: "2026-08-12T10:00:00.000Z",
              postponedUntil: null,
            },
          ],
        },
        { id: "QUEUE", label: "Queue", count: 0, workItems: [] },
        { id: "BUILD", label: "Build", count: 0, workItems: [] },
        { id: "REVIEW", label: "Review", count: 0, workItems: [] },
        { id: "PR", label: "PR", count: 0, workItems: [] },
        { id: "MERGED", label: "Merged", count: 0, workItems: [] },
      ],
    })

    expect(doc.schemaVersion).toBe(1)
    const rows = doc.lanes[0]?.workItems ?? []
    expect(
      rows.map((row) => [row.id, row.canRetry, row.state, row.status]),
    ).toEqual([
      ["wi-retryable-failed", true, "IMPLEMENT", "FAILED"],
      ["wi-terminal-failed", false, "FAILED", "FAILED"],
      ["wi-retryable-needs-human", true, "NEEDS_HUMAN", "NEEDS_HUMAN"],
      ["wi-unavailable-detail", true, "IMPLEMENT", "INTERRUPTED"],
    ])
    expect(rows[0]?.latestStepRunReason?.detail?.code).toBe("ENOENT")
    expect(rows[1]?.latestStepRunReason?.detail).toBeNull()
    expect(rows[3]?.latestStepRunReason?.detail).toBeNull()
    expect(encodeCompactJson(doc)).toContain('"schemaVersion":1')
    expect(encodeCompactJson(doc)).toContain('"canRetry":true')
    expect(encodeCompactJson(doc)).toContain('"latestStepRunReason"')
  })

  test("candidates success document includes issuesReconciledAt and actions", () => {
    const doc = buildCandidatesSuccessDocument({
      repository: {
        id: "repo-1",
        forge: "github",
        forgeHost: "github.com",
        projectPath: "owner/repo",
      },
      issuesReconciledAt: null,
      candidates: [
        {
          issueNumber: 3,
          title: "Ready",
          url: "https://github.com/owner/repo/issues/3",
          action: "IMPLEMENT_NOW",
        },
      ],
    })
    expect(doc).toEqual({
      schemaVersion: CLI_SCHEMA_VERSION,
      command: "candidates",
      repository: {
        id: "repo-1",
        forge: "github",
        forgeHost: "github.com",
        projectPath: "owner/repo",
      },
      issuesReconciledAt: null,
      candidates: [
        {
          issueNumber: 3,
          title: "Ready",
          url: "https://github.com/owner/repo/issues/3",
          action: "IMPLEMENT_NOW",
        },
      ],
    })
    expect(encodeCompactJson(doc)).toContain('"issuesReconciledAt":null')
  })

  test("intake success document discriminates CREATED and FAILED outcomes", () => {
    const doc = buildIntakeSuccessDocument({
      repository: {
        id: "repo-1",
        forge: "github",
        forgeHost: "github.com",
        projectPath: "owner/repo",
      },
      issuesReconciledAt: "2026-08-12T10:00:00.000Z",
      results: [
        {
          issueNumber: 101,
          title: "Implement feature",
          url: "https://github.com/owner/repo/issues/101",
          action: "IMPLEMENT_NOW",
          outcome: "CREATED",
          workItem: {
            id: "wi-1",
            state: "CREATE_WORKTREE",
            status: "QUEUED",
          },
        },
        {
          issueNumber: 102,
          title: "Blocked follow-up",
          url: "https://github.com/owner/repo/issues/102",
          action: "QUEUE",
          outcome: "FAILED",
          error: {
            code: "UNFINISHED_WORK_ITEM_EXISTS",
            message: "Issue #102 already has an unfinished Work Item",
          },
        },
      ],
    })
    expect(doc.command).toBe("intake")
    expect(doc.results).toHaveLength(2)
    expect(doc.results[0]).toMatchObject({
      outcome: "CREATED",
      workItem: { id: "wi-1" },
    })
    expect(doc.results[1]).toMatchObject({
      outcome: "FAILED",
      error: { code: "UNFINISHED_WORK_ITEM_EXISTS" },
    })
    expect(intakeHasFailedResults(doc.results)).toBe(true)
    expect(encodeCompactJson(doc)).toContain('"outcome":"CREATED"')
    expect(encodeCompactJson(doc)).toContain('"outcome":"FAILED"')
  })

  test("retry success document discriminates RETRIED, SKIPPED, and FAILED", () => {
    const doc = buildRetrySuccessDocument({
      repository: {
        id: "repo-1",
        forge: "github",
        forgeHost: "github.com",
        projectPath: "owner/repo",
      },
      results: [
        {
          issueNumber: 7,
          outcome: "RETRIED",
          workItem: {
            id: "wi-7",
            state: "IMPLEMENT",
            status: "QUEUED",
          },
        },
        {
          issueNumber: 8,
          outcome: "SKIPPED",
          workItem: {
            id: "wi-8",
            state: "IMPLEMENT",
            status: "FAILED",
          },
          reason: {
            code: "RETRY_NOT_ELIGIBLE",
            message: "Work Item wi-8 cannot be retried: paused",
          },
        },
        {
          issueNumber: 9,
          outcome: "FAILED",
          workItem: {
            id: "wi-9",
            state: "IMPLEMENT",
            status: "FAILED",
          },
          error: {
            code: "ACTIVE_STEP_RUN_EXISTS",
            message: "Work Item wi-9 already has an active Step Run",
          },
        },
      ],
    })
    expect(doc.command).toBe("retry")
    expect(doc.schemaVersion).toBe(1)
    expect(retryHasFailedResults(doc.results)).toBe(true)
    expect(encodeCompactJson(doc)).toContain('"outcome":"RETRIED"')
    expect(encodeCompactJson(doc)).toContain('"outcome":"SKIPPED"')
    expect(encodeCompactJson(doc)).toContain('"outcome":"FAILED"')
    expect(
      retryHasFailedResults([
        {
          issueNumber: 7,
          outcome: "RETRIED",
          workItem: { id: "wi-7", state: "IMPLEMENT", status: "QUEUED" },
        },
        {
          issueNumber: 8,
          outcome: "SKIPPED",
          workItem: { id: "wi-8", state: "IMPLEMENT", status: "FAILED" },
          reason: { code: "RETRY_NOT_ELIGIBLE", message: "paused" },
        },
      ]),
    ).toBe(false)
  })

  test("command-level error document is versioned and nested under error", () => {
    const doc = buildCommandErrorDocument({
      command: "add",
      code: "HARNESS_UNREACHABLE",
      message: "Harness is not running at http://127.0.0.1:1",
    })
    expect(doc).toEqual({
      schemaVersion: 1,
      command: "add",
      error: {
        code: "HARNESS_UNREACHABLE",
        message: "Harness is not running at http://127.0.0.1:1",
      },
    })
  })

  test("FiniteCommandFailed exposes the error document", () => {
    const failed = new FiniteCommandFailed({
      command: "add",
      code: "REPOSITORY_ALREADY_EXISTS",
      message: "Repository owner/repo already exists on github.com",
    })
    expect(failed.document).toEqual({
      schemaVersion: 1,
      command: "add",
      error: {
        code: "REPOSITORY_ALREADY_EXISTS",
        message: "Repository owner/repo already exists on github.com",
      },
    })
  })

  test("localGitErrorCode maps known tags", () => {
    expect(localGitErrorCode("PathNotFound")).toBe("PATH_NOT_FOUND")
    expect(localGitErrorCode("NotAGitRepository")).toBe("NOT_A_GIT_REPOSITORY")
    expect(localGitErrorCode("Other")).toBe("LOCAL_GIT_ERROR")
  })
})
