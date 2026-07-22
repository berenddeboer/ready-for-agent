import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  readLauncherVersion,
  writeReadyForAgentVersionFiles,
} from "../scripts/write-ready-for-agent-version.ts"
import { afterAll, describe, expect, test } from "bun:test"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")
const launcherVersionPath = join(appRoot, "src/generated/version.ts")
const harnessVersionPath = join(
  workspaceRoot,
  "apps/harness/src/generated/version.ts",
)

describe("ready-for-agent version generation", () => {
  afterAll(() => {
    writeReadyForAgentVersionFiles()
  })

  test("propagates a non-placeholder version to launcher and harness modules", () => {
    const nonPlaceholder = "4.5.6"
    const { version, paths } = writeReadyForAgentVersionFiles(nonPlaceholder)
    expect(version).toBe(nonPlaceholder)
    expect(paths).toHaveLength(2)

    const launcherSource = readFileSync(launcherVersionPath, "utf8")
    expect(launcherSource).toContain(
      `READY_FOR_AGENT_VERSION = "${nonPlaceholder}"`,
    )
    expect(launcherSource).not.toContain("READY_FOR_AGENT_VERSION_LABEL")
    expect(launcherSource).toContain("apps/ready-for-agent/package.json")
    expect(launcherSource).not.toContain("apps/harness/package.json")

    const harnessSource = readFileSync(harnessVersionPath, "utf8")
    expect(harnessSource).toContain(
      `READY_FOR_AGENT_VERSION = "${nonPlaceholder}"`,
    )
    expect(harnessSource).toContain(
      `READY_FOR_AGENT_VERSION_LABEL = "v${nonPlaceholder}"`,
    )
    expect(harnessSource).toContain("apps/ready-for-agent/package.json")
    expect(harnessSource).not.toContain("apps/harness/package.json")
  })

  test("defaults to the launcher package.json version", () => {
    const launcherVersion = readLauncherVersion()
    const { version } = writeReadyForAgentVersionFiles()
    expect(version).toBe(launcherVersion)
    expect(readFileSync(launcherVersionPath, "utf8")).toContain(
      `READY_FOR_AGENT_VERSION = ${JSON.stringify(launcherVersion)}`,
    )
    expect(readFileSync(harnessVersionPath, "utf8")).toContain(
      `READY_FOR_AGENT_VERSION = ${JSON.stringify(launcherVersion)}`,
    )
  })
})
