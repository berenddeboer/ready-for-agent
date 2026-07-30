import { issueActionEligibility } from "../src/issue-action-eligibility.js"
import { describe, expect, test } from "bun:test"

const openLeaf = {
  state: "OPEN" as const,
  hasChildren: false,
  blockedBy: [],
}

describe("Issue actionability UI smoke", () => {
  test("renders blocked, non-leaf, and unfinished-Work-Item Issues non-actionable", () => {
    const blocked = issueActionEligibility({
      issue: {
        ...openLeaf,
        blockedBy: [{ issueNumber: 17 }],
      },
      workItems: [],
      workItemsLoading: false,
    })
    const nonLeaf = issueActionEligibility({
      issue: {
        ...openLeaf,
        hasChildren: true,
      },
      workItems: [],
      workItemsLoading: false,
    })
    const unfinished = issueActionEligibility({
      issue: openLeaf,
      workItems: [
        { id: "wi-needs-human", state: "NEEDS_HUMAN", canRetry: false },
      ],
      workItemsLoading: false,
    })

    expect(blocked.canImplement).toBe(false)
    expect(blocked.canQueue).toBe(true)
    expect(nonLeaf).toEqual({ canImplement: false, canQueue: false })
    expect(unfinished).toEqual({ canImplement: false, canQueue: false })
  })

  test("renders an open leaf with only finished history actionable", () => {
    for (const state of ["COMPLETE", "FAILED", "ABANDONED"] as const) {
      expect(
        issueActionEligibility({
          issue: openLeaf,
          workItems: [
            { id: `wi-${state.toLowerCase()}`, state, canRetry: false },
          ],
          workItemsLoading: false,
        }),
      ).toEqual({ canImplement: true, canQueue: false })
    }
  })

  test("keeps retryable persisted failures non-actionable", () => {
    expect(
      issueActionEligibility({
        issue: openLeaf,
        workItems: [
          { id: "wi-retryable-failure", state: "FAILED", canRetry: true },
        ],
        workItemsLoading: false,
      }),
    ).toEqual({ canImplement: false, canQueue: false })
  })

  test("withholds actions while Work Items are loading", () => {
    expect(
      issueActionEligibility({
        issue: openLeaf,
        workItems: [],
        workItemsLoading: true,
      }),
    ).toEqual({ canImplement: false, canQueue: false })
  })
})
