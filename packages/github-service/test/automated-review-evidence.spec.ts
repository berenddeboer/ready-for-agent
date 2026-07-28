import { describe, expect, it } from "vitest"
import {
  GREEN_NO_REVIEW_EVIDENCE_REASON,
  inspectReviewerJobSteps,
  isRecognizedAutomatedReviewerLogin,
  isRecognizedAutomatedReviewerName,
  jobHasExecutedReviewerSteps,
} from "../src/lib/automated-review-evidence.js"

describe("automated review evidence recognition", () => {
  it("recognizes product reviewer names without matching ordinary review CI", () => {
    expect(
      isRecognizedAutomatedReviewerName("Claude Code Review/claude-review"),
    ).toBe(true)
    expect(isRecognizedAutomatedReviewerName("claude-review")).toBe(true)
    expect(isRecognizedAutomatedReviewerName("CodeRabbit")).toBe(true)
    expect(isRecognizedAutomatedReviewerName("PR Review/main")).toBe(false)
    expect(isRecognizedAutomatedReviewerName("review")).toBe(false)
    expect(isRecognizedAutomatedReviewerName("lint")).toBe(false)
  })

  it("recognizes known automated-review bot logins only", () => {
    expect(isRecognizedAutomatedReviewerLogin("claude[bot]")).toBe(true)
    expect(isRecognizedAutomatedReviewerLogin("coderabbitai[bot]")).toBe(true)
    expect(isRecognizedAutomatedReviewerLogin("github-actions[bot]")).toBe(
      false,
    )
    expect(isRecognizedAutomatedReviewerLogin("dependabot[bot]")).toBe(false)
    expect(isRecognizedAutomatedReviewerLogin("octocat")).toBe(false)
  })

  it("treats skipped and all-skipped-step jobs as not executed", () => {
    expect(
      inspectReviewerJobSteps({ conclusion: "skipped", steps: [] }),
    ).toEqual({ _tag: "not_executed" })
    expect(
      jobHasExecutedReviewerSteps({ conclusion: "skipped", steps: [] }),
    ).toBe(false)
    expect(
      inspectReviewerJobSteps({
        conclusion: "success",
        steps: [{ conclusion: "skipped" }, { conclusion: "skipped" }],
      }),
    ).toEqual({ _tag: "not_executed" })
    expect(
      inspectReviewerJobSteps({
        conclusion: "success",
        steps: [{ conclusion: "success" }],
      }),
    ).toEqual({ _tag: "executed" })
    expect(
      jobHasExecutedReviewerSteps({
        conclusion: "success",
        steps: [{ conclusion: "success" }],
      }),
    ).toBe(true)
    expect(GREEN_NO_REVIEW_EVIDENCE_REASON).toBe("green-no-review-evidence")
  })

  it("treats empty steps without an explicit skip conclusion as steps unavailable", () => {
    expect(
      inspectReviewerJobSteps({ conclusion: "success", steps: [] }),
    ).toEqual({ _tag: "steps_unavailable" })
    expect(
      inspectReviewerJobSteps({ conclusion: "failure", steps: null }),
    ).toEqual({ _tag: "steps_unavailable" })
    expect(inspectReviewerJobSteps({ steps: [] })).toEqual({
      _tag: "steps_unavailable",
    })
    expect(inspectReviewerJobSteps({ conclusion: null, steps: [] })).toEqual({
      _tag: "steps_unavailable",
    })
    expect(
      inspectReviewerJobSteps({ conclusion: "cancelled", steps: [] }),
    ).toEqual({ _tag: "not_executed" })
    expect(
      jobHasExecutedReviewerSteps({ conclusion: "success", steps: [] }),
    ).toBe(false)
  })

  it("treats non-empty steps with missing conclusions as steps unavailable", () => {
    expect(
      inspectReviewerJobSteps({
        conclusion: "success",
        steps: [{ conclusion: null }],
      }),
    ).toEqual({ _tag: "steps_unavailable" })
    expect(
      inspectReviewerJobSteps({
        conclusion: "success",
        steps: [{ conclusion: "skipped" }, { conclusion: null }],
      }),
    ).toEqual({ _tag: "steps_unavailable" })
    expect(
      inspectReviewerJobSteps({
        conclusion: "success",
        steps: [{}, { conclusion: "skipped" }],
      }),
    ).toEqual({ _tag: "steps_unavailable" })
    expect(
      jobHasExecutedReviewerSteps({
        conclusion: "success",
        steps: [{ conclusion: null }],
      }),
    ).toBe(false)
  })
})
