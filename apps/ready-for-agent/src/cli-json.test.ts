import {
  CLI_SCHEMA_VERSION,
  FiniteCommandFailed,
  buildAddSuccessDocument,
  buildCandidatesSuccessDocument,
  buildCommandErrorDocument,
  encodeCompactJson,
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
