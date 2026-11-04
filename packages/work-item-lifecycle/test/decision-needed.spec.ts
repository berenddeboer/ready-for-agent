import { parseAssessChangesResult } from "../src/lib/assess-changes.js"
import {
  decisionResumeTarget,
  parseDecisionNeeded,
} from "../src/lib/decision-needed.js"
import { describe, expect, it } from "bun:test"

describe("parseDecisionNeeded", () => {
  it("is absent when the turn has no decision marker", () => {
    expect(parseDecisionNeeded("Implemented the issue.")).toEqual({
      _tag: "absent",
    })
    expect(parseDecisionNeeded("READY_FOR_AGENT_RESULT: CHANGES")).toEqual({
      _tag: "absent",
    })
  })

  it("accepts a unique final marker with a preceding request", () => {
    expect(
      parseDecisionNeeded(
        [
          "Private-repository onboarding needs a choice.",
          "Options: signed enrollment, or a GitHub App.",
          "Recommendation: signed enrollment.",
          "READY_FOR_AGENT_RESULT: DECISION_NEEDED",
        ].join("\n"),
      ),
    ).toEqual({
      _tag: "needed",
      request: [
        "Private-repository onboarding needs a choice.",
        "Options: signed enrollment, or a GitHub App.",
        "Recommendation: signed enrollment.",
      ].join("\n"),
    })
  })

  it("rejects a marker with no request, a duplicate, or a contradictory result", () => {
    expect(
      parseDecisionNeeded("READY_FOR_AGENT_RESULT: DECISION_NEEDED")._tag,
    ).toBe("invalid")
    expect(
      parseDecisionNeeded(
        [
          "Which approach?",
          "READY_FOR_AGENT_RESULT: DECISION_NEEDED",
          "READY_FOR_AGENT_RESULT: DECISION_NEEDED",
        ].join("\n"),
      )._tag,
    ).toBe("invalid")
    expect(
      parseDecisionNeeded(
        [
          "Which approach?",
          "READY_FOR_AGENT_RESULT: DECISION_NEEDED",
          "READY_FOR_AGENT_RESULT: CHANGES",
        ].join("\n"),
      )._tag,
    ).toBe("invalid")
    expect(
      parseDecisionNeeded(
        [
          "READY_FOR_AGENT_RESULT: REVIEW_CLEAN",
          "Which approach?",
          "READY_FOR_AGENT_RESULT: DECISION_NEEDED",
        ].join("\n"),
      )._tag,
    ).toBe("invalid")
  })

  it("does not treat a decision request as Assess Changes success or no-change", () => {
    expect(
      parseAssessChangesResult(
        [
          "Implementation is still required. Which enrollment should I use?",
          "READY_FOR_AGENT_RESULT: DECISION_NEEDED",
        ].join("\n"),
      ),
    ).toEqual({
      _tag: "decision_needed",
      request:
        "Implementation is still required. Which enrollment should I use?",
    })
    expect(
      parseAssessChangesResult(
        [
          "READY_FOR_AGENT_RESULT: DECISION_NEEDED",
          "READY_FOR_AGENT_RESULT: NO_CHANGES",
        ].join("\n"),
      ),
    ).toBeNull()
  })

  it("resumes Implement from every decision origin", () => {
    expect(decisionResumeTarget("implement")).toBe("implement")
    expect(decisionResumeTarget("assess_changes")).toBe("implement")
    expect(decisionResumeTarget("review")).toBe("implement")
    expect(decisionResumeTarget("commit")).toBe("implement")
    expect(decisionResumeTarget("pre_commit")).toBe("implement")
  })
})
