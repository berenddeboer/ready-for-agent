import { renderToStaticMarkup } from "react-dom/server"
import { WorkItemOutcomePresentation } from "../src/work-item-outcome-presentation.js"
import {
  prBadgeClassName,
  statusBadgeClassNameForStatus,
} from "../src/work-item-progress-chrome.js"
import { describe, expect, test } from "bun:test"

const statusBadgeClassName = statusBadgeClassNameForStatus("COMPLETE")

describe("WorkItemOutcomePresentation", () => {
  test("renders no-change completion message, Issue link, and summary", () => {
    const html = renderToStaticMarkup(
      <WorkItemOutcomePresentation
        state="COMPLETE"
        statusLabel="Complete"
        statusBadgeClassName={statusBadgeClassName}
        pullRequestNumber={null}
        pullRequestUrl={null}
        completionSummary={
          "Investigated the question.\n\nFollow-up: https://github.com/acme/widgets/issues/9"
        }
        issueUrl="https://github.com/acme/widgets/issues/42"
      />,
    )

    expect(html).toContain("Issue closed without repository changes")
    expect(html).toContain('href="https://github.com/acme/widgets/issues/42"')
    expect(html).toContain('aria-label="Completion summary"')
    expect(html).toContain("Investigated the question.")
    expect(html).toContain("https://github.com/acme/widgets/issues/9")
    expect(html).toContain("Complete")
    expect(html).not.toContain("PR #")
    expect(html).not.toContain("Open pull request")
    expect(html).not.toContain("missing")
  })

  test("keeps pull-request number, link, and status presentation for changed work", () => {
    const html = renderToStaticMarkup(
      <WorkItemOutcomePresentation
        state="COMPLETE"
        statusLabel="Complete"
        statusBadgeClassName={statusBadgeClassName}
        pullRequestNumber={17}
        pullRequestUrl="https://github.com/acme/widgets/pull/17"
        completionSummary={null}
        issueUrl="https://github.com/acme/widgets/issues/3"
      />,
    )

    expect(html).toContain("PR #17 ↗")
    expect(html).toContain('href="https://github.com/acme/widgets/pull/17"')
    expect(html).toContain("Open pull request #17")
    expect(html).toContain("Complete")
    expect(html).toContain(prBadgeClassName)
    expect(html).not.toContain("Issue closed without repository changes")
    expect(html).not.toContain('aria-label="Completion summary"')
  })

  test("does not treat incomplete work without a PR as a No-Change Outcome", () => {
    const html = renderToStaticMarkup(
      <WorkItemOutcomePresentation
        state="IMPLEMENT"
        statusLabel="Running"
        statusBadgeClassName={statusBadgeClassNameForStatus("IMPLEMENT")}
        pullRequestNumber={null}
        pullRequestUrl={null}
        completionSummary={null}
        issueUrl="https://github.com/acme/widgets/issues/3"
      />,
    )

    expect(html).not.toContain("Issue closed without repository changes")
    expect(html).not.toContain('aria-label="Completion summary"')
    expect(html).toContain("Running")
  })

  test("omits the PR badge when showPullRequestBadge is false (Kanban promotion)", () => {
    const html = renderToStaticMarkup(
      <WorkItemOutcomePresentation
        state="DECIDE_PR_MERGE"
        statusLabel="Needs Human"
        statusBadgeClassName={statusBadgeClassNameForStatus("NEEDS_HUMAN")}
        pullRequestNumber={2418}
        pullRequestUrl="https://github.com/acme/widgets/pull/2418"
        completionSummary={null}
        issueUrl="https://github.com/acme/widgets/issues/2410"
        showPullRequestBadge={false}
      />,
    )

    // Single Needs Human alarm; status still links to the PR when URL exists.
    expect(html).toContain("Needs Human")
    expect(html).not.toContain("PR #2418 ↗")
    expect(html).not.toContain("PR #")
    expect(html).toContain('href="https://github.com/acme/widgets/pull/2418"')
    expect(html).toContain('aria-label="Open pull request #2418: Needs Human"')
  })

  test("keeps a status-only outcome when Needs Human has no PR", () => {
    const html = renderToStaticMarkup(
      <WorkItemOutcomePresentation
        state="DECIDE_PR_MERGE"
        statusLabel="Needs Human"
        statusBadgeClassName={statusBadgeClassNameForStatus("NEEDS_HUMAN")}
        pullRequestNumber={null}
        pullRequestUrl={null}
        completionSummary={null}
        issueUrl="https://github.com/acme/widgets/issues/2410"
      />,
    )

    expect(html).toContain("Needs Human")
    expect(html).not.toContain("PR #")
    expect(html).not.toContain("Open pull request")
    expect(html).not.toContain('href="https://github.com')
  })

  test("renders a compact rollup and tracker link for Spec Validation findings", () => {
    const html = renderToStaticMarkup(
      <WorkItemOutcomePresentation
        state="NEEDS_HUMAN"
        statusLabel="Decision needed"
        statusBadgeClassName={statusBadgeClassNameForStatus("NEEDS_HUMAN")}
        pullRequestNumber={null}
        pullRequestUrl={null}
        isSpecValidation
        completionSummary={[
          "Spec: https://linear.app/berenddeboer/issue/BER-59/validate",
          "Integrated checkout: `db0a0e2`",
          "### MET — Local MCP works",
          "- delivery (local): ok",
          "### UNMET — Deployed MCP works",
          "- defect (deployed): 404",
          "### UNVERIFIED — Live check",
          "- unavailable (other): no access",
          "Follow-up tickets:\n- [mcp-deployed: route](<https://linear.app/berenddeboer/issue/BER-69/fix>)",
        ].join("\n\n")}
        issueUrl={null}
      />,
    )

    expect(html).toContain("1 met · 1 unmet · 1 unverified · 1 follow-up")
    expect(html).toContain("View full report on Linear ↗")
    expect(html).toContain(
      'href="https://linear.app/berenddeboer/issue/BER-59/validate"',
    )
    expect(html).not.toContain("### MET")
    expect(html).not.toContain("Integrated checkout")

    const withCommentPermalink = renderToStaticMarkup(
      <WorkItemOutcomePresentation
        state="NEEDS_HUMAN"
        statusLabel="Decision needed"
        statusBadgeClassName={statusBadgeClassNameForStatus("NEEDS_HUMAN")}
        pullRequestNumber={null}
        pullRequestUrl={null}
        isSpecValidation
        completionSummary={[
          "Report: https://linear.app/berenddeboer/issue/BER-59/validate#comment-abc123",
          "Spec: https://linear.app/berenddeboer/issue/BER-59/validate",
          "### MET — Local MCP works",
          "- delivery (local): ok",
        ].join("\n\n")}
        issueUrl={null}
      />,
    )

    expect(withCommentPermalink).toContain(
      'href="https://linear.app/berenddeboer/issue/BER-59/validate#comment-abc123"',
    )
    expect(withCommentPermalink).toContain("View full report on Linear ↗")
  })
})
