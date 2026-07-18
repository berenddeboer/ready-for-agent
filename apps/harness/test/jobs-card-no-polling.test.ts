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

  test("splits Jobs into Working and Completed tabs with listKind queries", () => {
    const { source, jobsCard } = jobsCardSource()
    expect(jobsCard).toContain('role="tablist"')
    expect(jobsCard).toContain('aria-label="Jobs"')
    expect(jobsCard).toContain('role="tab"')
    expect(jobsCard).toContain('role="tabpanel"')
    expect(jobsCard).toContain("Working")
    expect(jobsCard).toContain("Completed")
    expect(jobsCard).toContain('useState<JobsTab>("working")')
    expect(jobsCard).toContain("jobsWorkingWorkItemsQuery")
    expect(jobsCard).toContain("jobsCompletedWorkItemsQuery")
    expect(jobsCard).toContain("No working jobs.")
    expect(jobsCard).toContain("No completed jobs.")
    expect(jobsCard).toContain("Working jobs")
    expect(jobsCard).toContain("Completed jobs")
    expect(jobsCard).not.toContain('aria-label="All jobs"')
    expect(source).toContain('listKind: "WORKING"')
    expect(source).toContain('listKind: "COMPLETED"')
    expect(source).toContain("JOBS_COMPLETED_LIMIT = 15")
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
    expect(stateLabelIndex).toBeGreaterThan(-1)
    expect(pauseIndex).toBeGreaterThan(stateLabelIndex)
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

  test("styles paused Needs human review like amber human handoff, not green Succeeded", () => {
    const { source } = jobsCardSource()
    expect(source).toContain('"NEEDS_HUMAN_REVIEW"')
    expect(source).toContain(
      'status === "NEEDS_HUMAN" || status === "NEEDS_HUMAN_REVIEW"',
    )
    expect(source).toContain("bg-amber-100 text-amber-800")
  })

  test("shows copyable session id and worktree path without Session prefix", () => {
    const { source, jobsCard } = jobsCardSource()
    expect(source).toContain("worktreePath: true")
    expect(source).toContain("sessionWorktreeParts")
    expect(source).toContain('from "../copy.js"')
    expect(jobsCard).toContain("sessionWorktreeParts")
    expect(jobsCard).toContain("value={sessionId}")
    expect(jobsCard).toContain("value={worktreePath}")
    expect(jobsCard).toContain("sessionId !== null && worktreePath !== null")
    expect(jobsCard).toMatch(/>\s*-\s*</)
    expect(jobsCard).not.toContain("value={sessionWorktree}")
    expect(jobsCard).not.toContain(" / ")
    expect(jobsCard).not.toContain("Session {workItem.sessionId}")
    expect(jobsCard).not.toContain("Session ")
  })
})
