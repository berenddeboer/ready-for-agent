import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"

describe("ready-for-agent target topology", () => {
  test("generates embedded client assets before running the source CLI", async () => {
    const project = JSON.parse(
      await readFile(new URL("../project.json", import.meta.url), "utf8"),
    ) as {
      targets: {
        run?: { dependsOn?: unknown[] }
        "generate-embed"?: { dependsOn?: unknown[] }
      }
    }

    expect(project.targets.run?.dependsOn).toContain("generate-embed")
    expect(project.targets["generate-embed"]?.dependsOn).toContain(
      "generate-version",
    )
  })

  test("harness build generates launcher version before client assets", async () => {
    const project = JSON.parse(
      await readFile(
        new URL("../../harness/project.json", import.meta.url),
        "utf8",
      ),
    ) as {
      targets: {
        build?: { dependsOn?: unknown[]; inputs?: unknown[] }
      }
    }

    expect(JSON.stringify(project.targets.build?.dependsOn ?? [])).toContain(
      '"target":"generate-version"',
    )
    expect(JSON.stringify(project.targets.build?.dependsOn ?? [])).toContain(
      '"projects":["ready-for-agent"]',
    )
    // Release bumps apps/ready-for-agent/package.json after CI has cached
    // harness:build at v0.0.0. Without this input, Nx restores the stale UI
    // while generate-version rewrites CLI version modules (issue #957).
    expect(JSON.stringify(project.targets.build?.inputs ?? [])).toContain(
      "apps/ready-for-agent/package.json",
    )
    expect(JSON.stringify(project.targets.build?.inputs ?? [])).toContain(
      "src/generated/version.ts",
    )
  })
})
