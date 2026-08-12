import {
  parseRepositoryIdentityArgument,
  resolveRepositoryIdentity,
} from "./repository-identity.ts"
import { describe, expect, test } from "bun:test"

describe("repository identity resolution", () => {
  test("parses forge-host/project-path including nested GitLab paths", () => {
    expect(parseRepositoryIdentityArgument("github.com/owner/repo")).toEqual({
      forgeHost: "github.com",
      projectPath: "owner/repo",
    })
    expect(
      parseRepositoryIdentityArgument(
        "git.drupalcode.org/project/oauth_client",
      ),
    ).toEqual({
      forgeHost: "git.drupalcode.org",
      projectPath: "project/oauth_client",
    })
  })

  test("rejects opaque IDs and malformed arguments", () => {
    expect(parseRepositoryIdentityArgument("repo-01ABC")).toBeNull()
    expect(parseRepositoryIdentityArgument("")).toBeNull()
    expect(parseRepositoryIdentityArgument("/owner/repo")).toBeNull()
    expect(parseRepositoryIdentityArgument("github.com/")).toBeNull()
  })

  test("matches case-insensitively and uniquely", () => {
    const repositories = [
      {
        id: "repo-1",
        forgeHost: "github.com",
        projectPath: "Owner/Repo",
      },
      {
        id: "repo-2",
        forgeHost: "git.drupalcode.org",
        projectPath: "project/oauth_client",
      },
    ]
    expect(
      resolveRepositoryIdentity("GitHub.com/owner/repo", repositories),
    ).toEqual({
      _tag: "matched",
      repository: repositories[0]!,
    })
    expect(
      resolveRepositoryIdentity("github.com/missing/repo", repositories),
    ).toEqual({
      _tag: "not_found",
      forgeHost: "github.com",
      projectPath: "missing/repo",
    })
    expect(resolveRepositoryIdentity("repo-1", repositories)).toEqual({
      _tag: "invalid",
      argument: "repo-1",
    })
  })

  test("reports ambiguous matches when more than one repository matches", () => {
    const repositories = [
      {
        id: "repo-1",
        forgeHost: "github.com",
        projectPath: "owner/repo",
      },
      {
        id: "repo-2",
        forgeHost: "GitHub.com",
        projectPath: "Owner/Repo",
      },
    ]
    expect(
      resolveRepositoryIdentity("github.com/owner/repo", repositories),
    ).toEqual({
      _tag: "ambiguous",
      forgeHost: "github.com",
      projectPath: "owner/repo",
      matchCount: 2,
    })
  })
})
