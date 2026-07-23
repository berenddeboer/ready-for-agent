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

  test("splits Jobs into Working, Failed, and Completed tabs with listKind queries", () => {
    const { source, jobsCard } = jobsCardSource()
    expect(jobsCard).toContain('role="tablist"')
    expect(jobsCard).toContain('aria-label="Jobs"')
    expect(jobsCard).toContain('role="tab"')
    expect(jobsCard).toContain('role="tabpanel"')
    expect(source).toContain('label: "Working"')
    expect(source).toContain('label: "Failed"')
    expect(source).toContain('label: "Completed"')
    expect(jobsCard).toContain('useState<JobsTab>("working")')
    expect(jobsCard).toContain("jobsWorkingWorkItemsQuery")
    expect(jobsCard).toContain("jobsFailedWorkItemsQuery")
    expect(jobsCard).toContain("jobsCompletedWorkItemsQuery")
    expect(source).toContain("No working jobs.")
    expect(source).toContain("No failed jobs.")
    expect(source).toContain("No completed jobs.")
    expect(source).toContain("Working jobs")
    expect(source).toContain("Failed jobs")
    expect(source).toContain("Completed jobs")
    expect(jobsCard).not.toContain('aria-label="All jobs"')
    expect(source).toContain('listKind: "WORKING"')
    expect(source).toContain('listKind: "FAILED"')
    expect(source).toContain('listKind: "COMPLETED"')
    expect(source).toContain("JOBS_COMPLETED_LIMIT = 15")
    expect(source).toContain("JOBS_FAILED_LIMIT = 15")
    const workingTabIndex = source.indexOf('label: "Working"')
    const failedTabIndex = source.indexOf('label: "Failed"')
    const completedTabIndex = source.indexOf('label: "Completed"')
    expect(workingTabIndex).toBeGreaterThan(-1)
    expect(failedTabIndex).toBeGreaterThan(workingTabIndex)
    expect(completedTabIndex).toBeGreaterThan(failedTabIndex)
  })

  test("shows live counts for Working and Failed, but not Completed", () => {
    const { jobsCard } = jobsCardSource()
    expect(jobsCard).toMatch(
      /\{tab\.id === "working" && ` \(\$\{workingItems\.length\}\)`\}/,
    )
    expect(jobsCard).toMatch(
      /\{tab\.id === "failed" && ` \(\$\{failedItems\.length\}\)`\}/,
    )
    expect(jobsCard).not.toContain('tab.id === "completed" &&')
  })

  test("shows issue number with title and top-right pause control", () => {
    const { source, jobsCard } = jobsCardSource()
    expect(jobsCard).not.toContain("Issue #")
    expect(jobsCard).toContain("#{workItem.githubIssueNumber}")
    expect(jobsCard).toContain("issueTitle")
    expect(source).toContain("issueTitle: true")
    expect(jobsCard).toContain(
      "issue?.title ?? workItem.issueTitle ?? undefined",
    )
    expect(jobsCard).toContain("issuesQuery(repository.id)")
    expect(jobsCard).toContain("title={issueIdentity}")
    expect(jobsCard).toContain("issueTitle === undefined")
    expect(jobsCard).toContain(`\`#\${workItem.githubIssueNumber}\``)
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
    expect(jobsCard).toContain("workItemIssueUrl(")
    expect(jobsCard).toContain("issueUrl={issueUrl}")
  })

  test("links status badge and Decide PR merge handoff to Work Item PR", () => {
    const { source, jobsCard } = jobsCardSource()
    expect(source).toContain("githubPullRequestNumber: true")
    expect(source).toContain("workItemPullRequestUrl")
    expect(source).toContain("WorkItemOutcomePresentation")
    expect(source).toContain("completionSummary: true")
    expect(jobsCard).toContain("workItemPullRequestUrl(")
    expect(jobsCard).toContain("workItem.githubPullRequestNumber")
    expect(source).toContain('target="_blank"')
    expect(source).toContain('rel="noopener noreferrer"')
    expect(source).toContain('lifecycleLabel.phase === "DECIDE_PR_MERGE"')
    expect(source).toContain('lifecycleLabel.status === "NEEDS_HUMAN"')
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

  test("Completed Session id opens usage dialog; Working/Failed keep plain copy", () => {
    const { source, jobsCard } = jobsCardSource()
    expect(jobsCard).toContain('selectedTab === "completed"')
    expect(jobsCard).toContain("setSessionDialogId(sessionId)")
    expect(jobsCard).toContain("SessionUsageDialog")
    expect(jobsCard).toContain("showValue={false}")
    expect(source).toContain("sessionQuery")
    expect(source).toContain("session: {")
    expect(source).toContain("availability: true")
    expect(source).toContain("cacheRead: true")
    expect(source).toContain("cacheWrite: true")
    expect(source).toContain('availability === "MISSING"')
    expect(source).toContain('availability === "UNAVAILABLE"')
    expect(source).toContain("formatSessionCost")
  })
})
