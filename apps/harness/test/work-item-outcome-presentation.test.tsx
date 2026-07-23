import { renderToStaticMarkup } from "react-dom/server"
import { WorkItemOutcomePresentation } from "../src/work-item-outcome-presentation.js"
import { describe, expect, test } from "bun:test"

const statusBadgeClassName =
  "rounded-full px-2 py-0.5 text-xs font-bold tracking-wide uppercase bg-green-100 text-green-700"

describe("WorkItemOutcomePresentation", () => {
  test("renders no-change completion message, Issue link, and summary", () => {
    const html = renderToStaticMarkup(
      <WorkItemOutcomePresentation
        state="COMPLETE"
        statusLabel="Complete"
        statusBadgeClassName={statusBadgeClassName}
        githubPullRequestNumber={null}
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
        githubPullRequestNumber={17}
        pullRequestUrl="https://github.com/acme/widgets/pull/17"
        completionSummary={null}
        issueUrl="https://github.com/acme/widgets/issues/3"
      />,
    )

    expect(html).toContain("PR #17")
    expect(html).toContain('href="https://github.com/acme/widgets/pull/17"')
    expect(html).toContain("Open pull request #17")
    expect(html).toContain("Complete")
    expect(html).not.toContain("Issue closed without repository changes")
    expect(html).not.toContain('aria-label="Completion summary"')
  })

  test("does not treat incomplete work without a PR as a No-Change Outcome", () => {
    const html = renderToStaticMarkup(
      <WorkItemOutcomePresentation
        state="IMPLEMENT"
        statusLabel="Running"
        statusBadgeClassName="bg-blue-100 text-blue-700"
        githubPullRequestNumber={null}
        pullRequestUrl={null}
        completionSummary={null}
        issueUrl="https://github.com/acme/widgets/issues/3"
      />,
    )

    expect(html).not.toContain("Issue closed without repository changes")
    expect(html).not.toContain('aria-label="Completion summary"')
    expect(html).toContain("Running")
  })
})
