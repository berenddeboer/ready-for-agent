import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"

describe("ready-for-agent target topology", () => {
  test("generates embedded client assets before running the source CLI", async () => {
    const project = JSON.parse(
      await readFile(new URL("../project.json", import.meta.url), "utf8"),
    ) as {
      targets: {
        run?: { dependsOn?: unknown[] }
      }
    }

    expect(project.targets.run?.dependsOn).toContain("generate-embed")
  })
})
