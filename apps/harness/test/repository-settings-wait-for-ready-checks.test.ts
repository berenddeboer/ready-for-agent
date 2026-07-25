import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const indexSource = () =>
  readFileSync(join(import.meta.dir, "../src/routes/index.tsx"), "utf8")

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
    expect(source).toContain("Disable only when becoming ready cannot")
    expect(source).toContain("start relevant workflows")
    expect(source).toContain("repository.waitForReadyForReviewChecks")
    expect(source).toContain('? "Enabled"')
    expect(source).toContain("Wait for ready checks:")
  })
})
