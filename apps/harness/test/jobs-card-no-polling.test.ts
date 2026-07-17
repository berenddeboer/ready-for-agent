import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const jobsCardSource = () => {
  const source = readFileSync(
    join(import.meta.dir, "../src/routes/index.tsx"),
    "utf8",
  )
  const jobsCardStart = source.indexOf("function JobsCard()")
  expect(jobsCardStart).toBeGreaterThan(-1)
  const jobsCardEnd = source.indexOf("function JobsCardSkeleton()")
  expect(jobsCardEnd).toBeGreaterThan(jobsCardStart)
  return {
    source,
    jobsCard: source.slice(jobsCardStart, jobsCardEnd),
  }
}

describe("JobsCard live updates", () => {
  test("does not poll workItems on a one-second interval", () => {
    const { source, jobsCard } = jobsCardSource()
    expect(jobsCard).not.toContain("refetchInterval")
    expect(jobsCard).not.toContain("1_000")
    expect(source).toContain("followRepositoryWorkItemsLive")
  })

  test("shows issue number with title and top-right pause control", () => {
    const { jobsCard } = jobsCardSource()
    expect(jobsCard).not.toContain("Issue #")
    expect(jobsCard).toContain("#{workItem.githubIssueNumber}")
    expect(jobsCard).toContain("issueTitle")
    expect(jobsCard).toContain("issuesQuery(repository.id)")
    expect(jobsCard).toContain("title={issueIdentity}")
    const pauseIndex = jobsCard.indexOf(
      "<WorkItemPauseButton workItem={workItem} />",
    )
    const stateLabelIndex = jobsCard.indexOf("{workItem.stateLabel}")
    expect(pauseIndex).toBeGreaterThan(-1)
    expect(stateLabelIndex).toBeGreaterThan(pauseIndex)
  })

  test("links issue identity to the Issue store URL when available", () => {
    const { jobsCard } = jobsCardSource()
    expect(jobsCard).toContain("issue.url")
    expect(jobsCard).toContain("href={issueUrl}")
    expect(jobsCard).toContain("text-blue-600 hover:underline")
    expect(jobsCard).not.toContain("hover:text-blue-700")
    expect(jobsCard).toContain('issueUrl !== undefined && issueUrl !== ""')
  })

  test("links status badge and Decide PR merge handoff to Work Item PR", () => {
    const { source, jobsCard } = jobsCardSource()
    expect(source).toContain("githubPullRequestNumber: true")
    expect(source).toContain("workItemPullRequestUrl")
    expect(jobsCard).toContain("workItemPullRequestUrl(")
    expect(jobsCard).toContain("workItem.githubPullRequestNumber")
    expect(source).toContain('target="_blank"')
    expect(source).toContain('rel="noopener noreferrer"')
    expect(source).toContain("Open pull request #")
    expect(source).toContain('lifecycleLabel.phase === "DECIDE_PR_MERGE"')
    expect(source).toContain('lifecycleLabel.status === "NEEDS_HUMAN"')
    expect(source).toContain("PR #{prNumber}")
  })
})
