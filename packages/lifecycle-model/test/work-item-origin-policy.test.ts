import { Effect } from "effect"
import {
  decodeWorkItemOrigin,
  publicationCopyOptions,
  workItemOriginPolicy,
} from "../src/work-item-origin-policy.js"
import { describe, expect, it } from "bun:test"

const linearSource = {
  tracker: "linear" as const,
  nativeId: "lin-1",
  displayId: "BER-1",
  url: "https://linear.app/berenddeboer/issue/BER-1",
}

describe("Work Item origin policy", () => {
  it("decodes known origins and fails unknown stored values", () => {
    expect(Effect.runSync(decodeWorkItemOrigin("issue"))).toBe("issue")
    expect(Effect.runSync(decodeWorkItemOrigin("ci_repair"))).toBe("ci_repair")

    for (const value of ["repair", "", null, undefined, 1]) {
      const error = Effect.runSync(Effect.flip(decodeWorkItemOrigin(value)))
      expect(error._tag).toBe("InvalidWorkItemOriginError")
    }
  })

  it("answers merge, pause, revalidation, naming, and wording without a fallback origin", () => {
    const issue = workItemOriginPolicy("issue")
    const repair = workItemOriginPolicy("ci_repair")

    expect(issue.nextStateAfterConfirmedMerge(linearSource)).toBe("close_issue")
    expect(issue.nextStateAfterConfirmedMerge(undefined)).toBe("local_cleanup")
    expect(repair.nextStateAfterConfirmedMerge(linearSource)).toBe(
      "local_cleanup",
    )
    expect(issue.noChangeNextState).toBe("close_issue")
    expect(repair.noChangeNextState).toBe("local_cleanup")
    expect(issue.pauseTargetAfterNoChange("commit")).toBe("close_issue")
    expect(repair.pauseTargetAfterNoChange("commit")).toBe("local_cleanup")
    expect(issue.pauseTargetAfterNoChange("review")).toBeUndefined()
    expect(issue.skipsIssueRevalidation).toBe(false)
    expect(repair.skipsIssueRevalidation).toBe(true)
    expect(
      issue.branchName({
        slug: "acme-widgets",
        issueNumber: 42,
        workItemId: "wi-1",
      }),
    ).toBe("rfa/acme-widgets/42/wi-1")
    expect(
      repair.branchName({
        slug: "acme-widgets",
        issueNumber: 0,
        workItemId: "wi-1",
      }),
    ).toBe("rfa/acme-widgets/ci-repair/wi-1")
    expect(
      repair.worktreeDirectoryName({ issueNumber: 0, workItemId: "wi-1" }),
    ).toBe("ci-repair-wi-1")
    expect(publicationCopyOptions("issue")).toBeUndefined()
    expect(publicationCopyOptions("ci_repair")).toEqual({ ciRepair: true })
    expect(
      repair.scopeIssueLine({
        issueUrl: null,
        repositoryId: "repo-1",
        issueNumber: 0,
      }),
    ).toBe(
      "Issue: none. This is a CI Repair Work Item. Do not create or close an Issue.",
    )
  })
})
