import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/home-page-content.tsx"), "utf8")

describe("Repository settings Wait for checks to start after ready for review", () => {
  test("exposes the ready-check wait checkbox, help text, and save path", () => {
    const source = indexSource()
    expect(source).toContain("Wait for checks to start after ready for review")
    expect(source).toContain(
      "const [waitForReadyForReviewChecks, setWaitForReadyForReviewChecks] =",
    )
    expect(source).toContain(
      "setWaitForReadyForReviewChecks(repository.waitForReadyForReviewChecks)",
    )
    expect(source).toContain("checked={waitForReadyForReviewChecks}")
    expect(source).toContain(
      "setWaitForReadyForReviewChecks(event.target.checked)",
    )
    expect(source).toMatch(
      /updateSettings\.mutate\(\{[\s\S]*waitForReadyForReviewChecks,[\s\S]*\}\)/,
    )
    expect(source).not.toContain(
      "waitForReadyForReviewChecks: repository.waitForReadyForReviewChecks",
    )
    expect(source).toContain(
      "Wait up to 90 seconds for workflows that start after a PR is",
    )
    expect(source).toContain(
      "workflows, turn off this setting to skip the wait.",
    )
    expect(source).toContain("repository.waitForReadyForReviewChecks")
    expect(source).toContain('? "Enabled"')
    expect(source).toContain("Wait for ready checks")
  })
})
