import { describe, expect, it } from "vitest"
import {
  GREEN_NO_REVIEW_EVIDENCE_REASON,
  INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE,
  classifyIncompleteAutomatedReviewOutput,
  extractWorkflowRunIdFromReviewComment,
  inspectReviewerJobSteps,
  isRecognizedAutomatedReviewerLogin,
  isRecognizedAutomatedReviewerName,
  jobHasExecutedReviewerSteps,
  workflowNameFromCheckName,
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

  it("classifies finished-banner + unchecked Aggregate task as incomplete", () => {
    const body = `**Claude finished @berenddeboer's task in 2m 35s** —— [View job](https://github.com/processfocus/monorepo/actions/runs/31549139160)

---
### Claude is reviewing this PR

- [x] Gather context
- [x] Launch sub-agents
- [ ] Aggregate findings and post review

Both sub-agents are running now.`
    expect(classifyIncompleteAutomatedReviewOutput(body)).toEqual({
      _tag: "incomplete",
      signature: INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE,
    })
    expect(extractWorkflowRunIdFromReviewComment(body)).toBe(31549139160)
  })

  it("does not treat a completed review body as incomplete", () => {
    const body = `**Claude finished @user's task**

## Findings
Standards review: clean.
Spec review: matches issue.

- [x] Aggregate findings and post review
`
    expect(classifyIncompleteAutomatedReviewOutput(body)).toEqual({
      _tag: "complete",
    })
  })

  it("does not treat arbitrary unchecked boxes without a finished banner as incomplete", () => {
    expect(
      classifyIncompleteAutomatedReviewOutput(
        "- [ ] Aggregate findings and post review\n- [ ] something else",
      ),
    ).toEqual({ _tag: "complete" })
  })

  it("classifies finished banner + unchecked progress without synthesis as incomplete", () => {
    const body = `**Claude finished @user's task**

### Claude is reviewing this PR
- [x] Gather context
- [ ] Pin fixed point and confirm diff
`
    expect(classifyIncompleteAutomatedReviewOutput(body)).toEqual({
      _tag: "incomplete",
      signature: INCOMPLETE_AUTOMATED_REVIEW_SIGNATURE,
    })
  })

  it("derives workflow identity from check names", () => {
    expect(workflowNameFromCheckName("Claude Code Review/claude-review")).toBe(
      "Claude Code Review",
    )
    expect(workflowNameFromCheckName("CodeRabbit")).toBe("CodeRabbit")
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
