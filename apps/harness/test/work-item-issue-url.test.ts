import { workItemIssueUrl } from "../src/work-item-issue-url.js"
import { describe, expect, test } from "bun:test"

describe("workItemIssueUrl", () => {
  test("builds GitHub Issue URL from repository identity and issue number", () => {
    expect(workItemIssueUrl("acme", "widgets", 42)).toBe(
      "https://github.com/acme/widgets/issues/42",
    )
  })
})
