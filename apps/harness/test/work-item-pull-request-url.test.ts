import { workItemPullRequestUrl } from "../src/work-item-pull-request-url.js"
import { describe, expect, test } from "bun:test"

describe("workItemPullRequestUrl", () => {
  test("builds GitHub PR URL from repository identity and Work Item PR number", () => {
    expect(workItemPullRequestUrl("acme", "widgets", 42)).toBe(
      "https://github.com/acme/widgets/pull/42",
    )
  })

  test("returns null when no Work Item PR is recorded", () => {
    expect(workItemPullRequestUrl("acme", "widgets", null)).toBeNull()
  })
})
