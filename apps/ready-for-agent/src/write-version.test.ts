import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  assertClientDistMatchesProductVersion,
  parseMastheadProductVersion,
  productVersionLabel,
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

  test("parseMastheadProductVersion reads title attribute, not SSR text splits", () => {
    const html = `<b title="Ready for Agent v1.2.3">RFA <!-- -->v1.2.3</b>`
    expect(parseMastheadProductVersion(html)).toBe("1.2.3")
    expect(productVersionLabel("1.2.3")).toBe("v1.2.3")
  })

  test("assertClientDistMatchesProductVersion accepts matching shell and JS", () => {
    const root = mkdtempSync(join(tmpdir(), "rfa-client-dist-"))
    try {
      mkdirSync(join(root, "assets"), { recursive: true })
      writeFileSync(
        join(root, "_shell.html"),
        `<b title="Ready for Agent v9.8.7">RFA v9.8.7</b>`,
      )
      writeFileSync(join(root, "assets", "index.js"), `var xl=\`v9.8.7\`;`)
      expect(() =>
        assertClientDistMatchesProductVersion(root, "9.8.7"),
      ).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("assertClientDistMatchesProductVersion rejects stale placeholder UI", () => {
    const root = mkdtempSync(join(tmpdir(), "rfa-client-dist-stale-"))
    try {
      mkdirSync(join(root, "assets"), { recursive: true })
      writeFileSync(
        join(root, "_shell.html"),
        `<b title="Ready for Agent v0.0.0">RFA v0.0.0</b>`,
      )
      writeFileSync(join(root, "assets", "index.js"), `var xl=\`v0.0.0\`;`)
      expect(() =>
        assertClientDistMatchesProductVersion(root, "0.19.0"),
      ).toThrow(/does not embed product version "v0.19.0"/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
