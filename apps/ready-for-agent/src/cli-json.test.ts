import {
  CLI_SCHEMA_VERSION,
  FiniteCommandFailed,
  buildAddSuccessDocument,
  buildCandidatesSuccessDocument,
  buildCommandErrorDocument,
  buildIntakeSuccessDocument,
  buildStatusSuccessDocument,
  encodeCompactJson,
  intakeHasFailedResults,
  localGitErrorCode,
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
    expect(encodeCompactJson(doc)).toContain('"command":"status"')
    expect(encodeCompactJson(doc)).toContain('"pullRequestNumber":null')
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
