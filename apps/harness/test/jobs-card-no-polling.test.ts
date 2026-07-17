import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

describe("JobsCard live updates", () => {
  test("does not poll workItems on a one-second interval", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/routes/index.tsx"),
      "utf8",
    )
    const jobsCardStart = source.indexOf("function JobsCard()")
    expect(jobsCardStart).toBeGreaterThan(-1)
    const jobsCardEnd = source.indexOf("function JobsCardSkeleton()")
    expect(jobsCardEnd).toBeGreaterThan(jobsCardStart)
    const jobsCard = source.slice(jobsCardStart, jobsCardEnd)
    expect(jobsCard).not.toContain("refetchInterval")
    expect(jobsCard).not.toContain("1_000")
    expect(source).toContain("followRepositoryWorkItemsLive")
  })
})
