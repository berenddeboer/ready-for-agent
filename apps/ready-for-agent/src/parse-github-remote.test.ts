import { Option } from "effect"
import { parseGitHubRemote } from "./parse-github-remote.ts"
import { describe, expect, test } from "bun:test"

const expectRemote = (url: string, owner: string, repo: string): void => {
  const result = parseGitHubRemote(url)
  expect(Option.isSome(result)).toBe(true)
  if (Option.isSome(result)) {
    expect(result.value).toEqual({ owner, repo })
  }
}

const expectNone = (url: string): void => {
  expect(Option.isNone(parseGitHubRemote(url))).toBe(true)
}

describe("parseGitHubRemote", () => {
  test("ssh scp-style", () => {
    expectRemote("git@github.com:owner/repo.git", "owner", "repo")
    expectRemote("git@github.com:owner/repo", "owner", "repo")
  })

  test("ssh host aliases (multi-account ~/.ssh/config)", () => {
    expectRemote("git@github.com-work:acme/widget.git", "acme", "widget")
    expectRemote("git@github.com-personal:me/dotfiles", "me", "dotfiles")
  })

  test("https", () => {
    expectRemote("https://github.com/owner/repo.git", "owner", "repo")
    expectRemote("https://github.com/owner/repo", "owner", "repo")
    expectRemote("https://www.github.com/owner/repo.git", "owner", "repo")
    expectRemote("http://github.com/owner/repo.git", "owner", "repo")
  })

  test("https with embedded credentials", () => {
    expectRemote(
      "https://user:token@github.com/owner/repo.git",
      "owner",
      "repo",
    )
    expectRemote(
      "https://x-access-token:ghs_abc123@github.com/org/app.git",
      "org",
      "app",
    )
  })

  test("ssh:// URLs", () => {
    expectRemote("ssh://git@github.com/owner/repo.git", "owner", "repo")
    expectRemote("ssh://git@github.com-work/owner/repo.git", "owner", "repo")
  })

  test("git:// URLs", () => {
    expectRemote("git://github.com/owner/repo.git", "owner", "repo")
  })

  test("trims whitespace and strips trailing slash", () => {
    expectRemote("  git@github.com:owner/repo.git  ", "owner", "repo")
    expectRemote("https://github.com/owner/repo/", "owner", "repo")
  })

  test("rejects non-GitHub remotes", () => {
    expectNone("git@gitlab.com:owner/repo.git")
    expectNone("https://gitlab.com/owner/repo.git")
    expectNone("https://bitbucket.org/owner/repo.git")
    expectNone("not-a-url")
    expectNone("")
  })
})
