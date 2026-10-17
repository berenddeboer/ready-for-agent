import { readFileSync } from "node:fs"
import { join } from "node:path"
import { REPAIR_SKILL } from "../src/lib/repair-skill.js"
import { describe, expect, test } from "bun:test"

describe("bundled repair skill", () => {
  test("matches the source skill delivered to the agent", () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        "../../../.agents/skills/repair-ci-cd-pipeline/SKILL.md",
      ),
      "utf8",
    )
    expect(REPAIR_SKILL).toBe(source)
  })
})
