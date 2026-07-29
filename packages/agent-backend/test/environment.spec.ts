import { sanitizeInheritedEnvironment } from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("sanitizeInheritedEnvironment", () => {
  it("drops only Forge token names by default", () => {
    const result = sanitizeInheritedEnvironment({
      HOME: "/home/user",
      GH_TOKEN: "a",
      GITHUB_TOKEN: "b",
      GITHUB_TOKEN_REPO: "c",
      GITLAB_TOKEN: "d",
      GITLAB_TOKEN_REPO: "e",
      GITLAB_TOKENPROJECT: "f",
      NOT_GITHUB_TOKEN: "keep",
      NOT_GITLAB_TOKEN: "keep-too",
    })
    expect(result).toEqual({
      HOME: "/home/user",
      NOT_GITHUB_TOKEN: "keep",
      NOT_GITLAB_TOKEN: "keep-too",
    })
  })

  it("preserves Forge token names when stripForgeTokens is false", () => {
    const result = sanitizeInheritedEnvironment(
      {
        HOME: "/home/user",
        GH_TOKEN: "a",
        GITHUB_TOKEN: "b",
        GITHUB_TOKEN_REPO: "c",
        GITLAB_TOKEN: "d",
        GITLAB_TOKEN_REPO: "e",
        GITLAB_TOKENPROJECT: "f",
        NOT_GITHUB_TOKEN: "keep",
      },
      { stripForgeTokens: false },
    )
    expect(result).toEqual({
      HOME: "/home/user",
      GH_TOKEN: "a",
      GITHUB_TOKEN: "b",
      GITHUB_TOKEN_REPO: "c",
      GITLAB_TOKEN: "d",
      GITLAB_TOKEN_REPO: "e",
      GITLAB_TOKENPROJECT: "f",
      NOT_GITHUB_TOKEN: "keep",
    })
  })

  it("supports independent Forge token policies", () => {
    expect(
      sanitizeInheritedEnvironment(
        {
          GITHUB_TOKEN: "github",
          GITLAB_TOKEN: "gitlab",
        },
        {
          stripGitHubTokens: true,
          stripGitLabTokens: false,
        },
      ),
    ).toEqual({
      GITLAB_TOKEN: "gitlab",
    })
  })

  it("keeps stripGitHubTokens scoped to GitHub", () => {
    expect(
      sanitizeInheritedEnvironment(
        {
          GITHUB_TOKEN: "github",
          GITLAB_TOKEN: "gitlab",
        },
        { stripGitHubTokens: false },
      ),
    ).toEqual({
      GITHUB_TOKEN: "github",
    })
  })
})
