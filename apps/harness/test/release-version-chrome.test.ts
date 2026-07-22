import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

describe("release version in shared UI chrome", () => {
  test("root layout renders launcher build version as v<semver>", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/routes/__root.tsx"),
      "utf8",
    )
    expect(source).toContain('from "../generated/version"')
    expect(source).toContain("READY_FOR_AGENT_VERSION_LABEL")
    expect(source).toContain("{READY_FOR_AGENT_VERSION_LABEL}")
  })

  test("generated version module is the launcher product version, not harness package metadata", () => {
    const versionSource = readFileSync(
      join(import.meta.dir, "../src/generated/version.ts"),
      "utf8",
    )
    expect(versionSource).toContain("READY_FOR_AGENT_VERSION")
    expect(versionSource).toContain("READY_FOR_AGENT_VERSION_LABEL")
    expect(versionSource).toContain("from apps/ready-for-agent/package.json")
    expect(versionSource).not.toContain("apps/harness/package.json")
  })
})
