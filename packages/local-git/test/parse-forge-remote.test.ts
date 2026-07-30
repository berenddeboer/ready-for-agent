import { Option } from "effect"
import { parseForgeRemote } from "../src/lib/parse-forge-remote.js"
import { describe, expect, test } from "bun:test"

const expectRemote = (
  url: string,
  expected: {
    readonly forge: "github" | "gitlab"
    readonly forgeHost: string
    readonly projectPath: string
  },
): void => {
  const result = parseForgeRemote(url)
  expect(Option.isSome(result)).toBe(true)
  if (Option.isSome(result)) {
    expect(result.value).toEqual(expected)
  }
}

describe("parseForgeRemote", () => {
  test("recognizes GitHub spellings", () => {
    expectRemote("git@github.com:owner/repo.git", {
      forge: "github",
      forgeHost: "github.com",
      projectPath: "owner/repo",
    })
    expectRemote("https://github.com/owner/repo", {
      forge: "github",
      forgeHost: "github.com",
      projectPath: "owner/repo",
    })
  })

  test("recognizes GitLab nested project paths", () => {
    expectRemote("git@gitlab.example:group/nested/project.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example",
      projectPath: "group/nested/project",
    })
    expectRemote("https://gitlab.example/group/nested/project.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example",
      projectPath: "group/nested/project",
    })
    expectRemote("ssh://git@gitlab.example/group/nested/project.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example",
      projectPath: "group/nested/project",
    })
  })

  test("treats non-GitHub network hosts as correctable GitLab guesses", () => {
    expectRemote("git@bitbucket.org:owner/repo.git", {
      forge: "gitlab",
      forgeHost: "bitbucket.org",
      projectPath: "owner/repo",
    })
  })

  test("keeps non-default HTTPS ports in the Forge Host guess", () => {
    expectRemote("https://gitlab.example.com:8443/group/app.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example.com:8443",
      projectPath: "group/app",
    })
    expectRemote("http://gitlab.internal:8080/group/app", {
      forge: "gitlab",
      forgeHost: "gitlab.internal:8080",
      projectPath: "group/app",
    })
  })

  test("does not treat SSH URL ports as the API Forge Host port", () => {
    expectRemote("ssh://git@gitlab.example.com:2222/group/app.git", {
      forge: "gitlab",
      forgeHost: "gitlab.example.com",
      projectPath: "group/app",
    })
  })

  test("rejects local and malformed remotes", () => {
    expect(Option.isNone(parseForgeRemote("../owner/repo.git"))).toBe(true)
    expect(Option.isNone(parseForgeRemote("not-a-url"))).toBe(true)
  })
})
