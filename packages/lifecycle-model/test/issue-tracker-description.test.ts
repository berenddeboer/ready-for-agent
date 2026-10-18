import {
  FORGES,
  ISSUE_TRACKERS,
  ISSUE_TRACKER_DESCRIPTIONS,
  behaviourNotImplemented,
  describeIssueTracker,
  relevancePolicyForForge,
  relevancePolicyForIssueTracker,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("Issue Tracker descriptions", () => {
  it("describes exactly the Issue Tracker kinds of the vocabulary", () => {
    expect(Object.keys(ISSUE_TRACKER_DESCRIPTIONS).sort()).toEqual(
      [...ISSUE_TRACKERS].sort(),
    )
  })

  it("describes each Forge-hosted kind by its hosting Forge", () => {
    for (const forge of FORGES) {
      const description = describeIssueTracker(forge)
      expect(description.availability.kind).toBe("hosting_forge")
      expect(description.credential).toEqual({ kind: "hosting_forge" })
      expect(description.issueIdentity).toEqual({ kind: "issue_number" })
      expect(description.presentation).toEqual({ kind: "forge_issue" })
      expect(description.pullRequestReference).toEqual({
        kind: "forge_closing_reference",
      })
      expect(description.afterConfirmedMerge).toEqual({
        kind: "local_cleanup",
      })
      expect(description.parentImplementAll).toEqual({ kind: "available" })
      expect(relevancePolicyForIssueTracker(forge)).toEqual(
        relevancePolicyForForge(forge),
      )
    }
  })

  it("describes Linear as a GitHub-only tracker with its own credential", () => {
    const linear = describeIssueTracker("linear")
    expect(linear.availability).toEqual({
      kind: "forges",
      forges: ["github"],
      unavailableMessage:
        "Linear is available only for GitHub-hosted Repositories",
    })
    expect(linear.settings).toEqual({ kind: "linear_project_mapping" })
    expect(linear.credential).toEqual({ kind: "linear_api_key" })
    expect(linear.issueIdentity).toEqual({ kind: "native_id" })
    expect(linear.afterConfirmedMerge).toEqual({
      kind: "close_issue",
      completionSummary:
        "Ready for Agent completed this Issue after the GitHub pull request merged.",
    })
    expect(linear.parentImplementAll.kind).toBe("unavailable")
  })

  it("keeps fp unselectable and names each behaviour it does not have yet", () => {
    const fp = describeIssueTracker("fp")
    expect(fp.availability).toEqual({
      kind: "not_selectable",
      message: "fp is not yet available as an Issue Tracker",
    })
    expect(fp.credential).toEqual({ kind: "none" })
    expect(fp.issueIdentity).toEqual({ kind: "native_id" })
    for (const behaviour of [
      fp.settings,
      fp.presentation,
      fp.pullRequestReference,
      fp.afterConfirmedMerge,
      fp.parentImplementAll,
    ]) {
      expect(behaviour).toEqual({ kind: "not_implemented" })
    }
  })

  it("lets only an unselectable kind lack a behaviour", () => {
    for (const tracker of ISSUE_TRACKERS) {
      const description = describeIssueTracker(tracker)
      const missing = Object.values(description).some(
        (fact) =>
          typeof fact === "object" &&
          fact !== null &&
          "kind" in fact &&
          fact.kind === "not_implemented",
      )
      if (missing) {
        expect(description.availability.kind).toBe("not_selectable")
      }
    }
  })

  it("treats reaching a missing behaviour as a defect", () => {
    expect(() => behaviourNotImplemented("fp", "presentation")).toThrow(
      "Issue Tracker fp has no presentation yet and is not selectable",
    )
  })
})
