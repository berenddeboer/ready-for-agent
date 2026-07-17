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
})
