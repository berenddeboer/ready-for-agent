import { workItemIssueUrl } from "../src/work-item-issue-url.js"
import { describe, expect, test } from "bun:test"

describe("workItemIssueUrl", () => {
  test("builds GitHub Issue URL from repository identity and issue number", () => {
    expect(workItemIssueUrl("github", "github.com", "acme/widgets", 42)).toBe(
      "https://github.com/acme/widgets/issues/42",
    )
  })

  test("builds GitLab Issue URL with the /-/issues/ path segment", () => {
    expect(
      workItemIssueUrl(
        "gitlab",
        "git.drupalcode.org",
        "project/oauth_client",
        3601642,
      ),
    ).toBe("https://git.drupalcode.org/project/oauth_client/-/issues/3601642")
  })
})
