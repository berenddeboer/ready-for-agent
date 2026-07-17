import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BINARY_RELATIVE_PATH,
  PLATFORM_PACKAGE_NAMES,
  SUPPORTED_PLATFORM_KEYS,
  bunCompileTarget,
  selectPlatformPackage,
  unsupportedPlatformMessage,
} from "../bin/select-platform.js"
import { describe, expect, test } from "bun:test"

const binDir = dirname(fileURLToPath(import.meta.url))
const launcherSource = readFileSync(
  join(binDir, "../bin/ready-for-agent.js"),
  "utf8",
)

describe("selectPlatformPackage", () => {
  test("selects each supported linux/darwin × x64/arm64 package", () => {
    const cases = [
      {
        platform: "linux",
        arch: "x64",
        platformKey: "linux-x64",
        packageName: "ready-for-agent-linux-x64",
      },
      {
        platform: "linux",
        arch: "arm64",
        platformKey: "linux-arm64",
        packageName: "ready-for-agent-linux-arm64",
      },
      {
        platform: "darwin",
        arch: "x64",
        platformKey: "darwin-x64",
        packageName: "ready-for-agent-darwin-x64",
      },
      {
        platform: "darwin",
        arch: "arm64",
        platformKey: "darwin-arm64",
        packageName: "ready-for-agent-darwin-arm64",
      },
    ] as const

    for (const c of cases) {
      const result = selectPlatformPackage({
        platform: c.platform,
        arch: c.arch,
      })
      expect(result).toEqual({
        ok: true,
        platformKey: c.platformKey,
        packageName: c.packageName,
        binaryRelativePath: BINARY_RELATIVE_PATH,
      })
    }
  })

  test("normalizes common arch aliases", () => {
    expect(
      selectPlatformPackage({ platform: "linux", arch: "x86_64" }),
    ).toMatchObject({ ok: true, platformKey: "linux-x64" })
    expect(
      selectPlatformPackage({ platform: "linux", arch: "amd64" }),
    ).toMatchObject({ ok: true, platformKey: "linux-x64" })
    expect(
      selectPlatformPackage({ platform: "darwin", arch: "aarch64" }),
    ).toMatchObject({ ok: true, platformKey: "darwin-arm64" })
  })

  test("unsupported platforms get a clear error listing supported keys", () => {
    const win = selectPlatformPackage({ platform: "win32", arch: "x64" })
    expect(win.ok).toBe(false)
    if (win.ok) throw new Error("expected unsupported")
    expect(win.message).toContain("win32/x64")
    expect(win.message).toContain("Windows is not supported in v1")
    for (const key of SUPPORTED_PLATFORM_KEYS) {
      expect(win.message).toContain(key)
    }

    const freebsd = selectPlatformPackage({
      platform: "freebsd",
      arch: "x64",
    })
    expect(freebsd.ok).toBe(false)
    if (freebsd.ok) throw new Error("expected unsupported")
    expect(freebsd.message).toBe(unsupportedPlatformMessage("freebsd", "x64"))

    const weirdArch = selectPlatformPackage({
      platform: "linux",
      arch: "ia32",
    })
    expect(weirdArch.ok).toBe(false)
  })

  test("PLATFORM_PACKAGE_NAMES covers every supported key", () => {
    expect(Object.keys(PLATFORM_PACKAGE_NAMES).sort()).toEqual(
      [...SUPPORTED_PLATFORM_KEYS].sort(),
    )
  })

  test("bun compile targets map 1:1 for supported platforms", () => {
    expect(bunCompileTarget("linux-x64")).toBe("bun-linux-x64")
    expect(bunCompileTarget("linux-arm64")).toBe("bun-linux-arm64")
    expect(bunCompileTarget("darwin-x64")).toBe("bun-darwin-x64")
    expect(bunCompileTarget("darwin-arm64")).toBe("bun-darwin-arm64")
  })

  test("launcher bin imports the shared select-platform pure seam", () => {
    expect(launcherSource).toContain('from "./select-platform.js"')
    expect(launcherSource).toContain("selectPlatformPackage")
    for (const name of Object.values(PLATFORM_PACKAGE_NAMES)) {
      expect(Object.values(PLATFORM_PACKAGE_NAMES)).toContain(name)
    }
  })
})
