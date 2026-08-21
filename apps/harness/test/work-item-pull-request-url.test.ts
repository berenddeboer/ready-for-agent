import { workItemPullRequestUrl } from "../src/work-item-pull-request-url.js"
import { describe, expect, test } from "bun:test"

describe("workItemPullRequestUrl", () => {
  test("builds GitHub PR URL from repository identity and Work Item PR number", () => {
    expect(
      workItemPullRequestUrl("github", "github.com", "acme/widgets", 42),
    ).toBe("https://github.com/acme/widgets/pull/42")
  })

  test("builds GitLab MR URL with the /-/merge_requests/ path segment", () => {
    expect(
      workItemPullRequestUrl(
        "gitlab",
        "git.drupalcode.org",
        "project/oauth_client",
        91,
      ),
    ).toBe(
      "https://git.drupalcode.org/project/oauth_client/-/merge_requests/91",
    )
  })

  test("builds Azure DevOps PR URL when project and repository names match", () => {
    expect(
      workItemPullRequestUrl(
        "azure-devops",
        "dev.azure.com",
        "acme/widgets",
        91,
      ),
    ).toBe("https://dev.azure.com/acme/widgets/_git/widgets/pullrequest/91")
  })

  test("builds Azure DevOps PR URL with a distinct Git repository name", () => {
    expect(
      workItemPullRequestUrl(
        "azure-devops",
        "dev.azure.com",
        "acme/Default/gantry",
        91,
      ),
    ).toBe("https://dev.azure.com/acme/Default/_git/gantry/pullrequest/91")
  })

  test("returns null when no Work Item PR is recorded", () => {
    expect(
      workItemPullRequestUrl("github", "github.com", "acme/widgets", null),
    ).toBeNull()
  })
})
