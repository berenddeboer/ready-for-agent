import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BINARY_RELATIVE_PATH,
  PLATFORM_PACKAGE_NAMES,
  SUPPORTED_PLATFORM_KEYS,
  WINDOWS_BINARY_RELATIVE_PATH,
  binaryRelativePathFor,
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
  test("selects each supported linux/darwin/win32 × x64/arm64 package", () => {
    const cases = [
      {
        platform: "linux",
        arch: "x64",
        platformKey: "linux-x64",
        packageName: "ready-for-agent-linux-x64",
        binaryRelativePath: BINARY_RELATIVE_PATH,
      },
      {
        platform: "linux",
        arch: "arm64",
        platformKey: "linux-arm64",
        packageName: "ready-for-agent-linux-arm64",
        binaryRelativePath: BINARY_RELATIVE_PATH,
      },
      {
        platform: "darwin",
        arch: "x64",
        platformKey: "darwin-x64",
        packageName: "ready-for-agent-darwin-x64",
        binaryRelativePath: BINARY_RELATIVE_PATH,
      },
      {
        platform: "darwin",
        arch: "arm64",
        platformKey: "darwin-arm64",
        packageName: "ready-for-agent-darwin-arm64",
        binaryRelativePath: BINARY_RELATIVE_PATH,
      },
      {
        platform: "win32",
        arch: "x64",
        platformKey: "win32-x64",
        packageName: "ready-for-agent-win32-x64",
        binaryRelativePath: WINDOWS_BINARY_RELATIVE_PATH,
      },
      {
        platform: "win32",
        arch: "arm64",
        platformKey: "win32-arm64",
        packageName: "ready-for-agent-win32-arm64",
        binaryRelativePath: WINDOWS_BINARY_RELATIVE_PATH,
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
        binaryRelativePath: c.binaryRelativePath,
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
    expect(
      selectPlatformPackage({ platform: "win32", arch: "x86_64" }),
    ).toMatchObject({ ok: true, platformKey: "win32-x64" })
    expect(
      selectPlatformPackage({ platform: "win32", arch: "aarch64" }),
    ).toMatchObject({ ok: true, platformKey: "win32-arm64" })
  })

  test("unsupported platforms get a clear error listing supported keys", () => {
    const freebsd = selectPlatformPackage({
      platform: "freebsd",
      arch: "x64",
    })
    expect(freebsd.ok).toBe(false)
    if (freebsd.ok) throw new Error("expected unsupported")
    expect(freebsd.message).toBe(unsupportedPlatformMessage("freebsd", "x64"))
    expect(freebsd.message).not.toContain("Windows is not supported")
    for (const key of SUPPORTED_PLATFORM_KEYS) {
      expect(freebsd.message).toContain(key)
    }

    const weirdArch = selectPlatformPackage({
      platform: "linux",
      arch: "ia32",
    })
    expect(weirdArch.ok).toBe(false)

    const android = selectPlatformPackage({
      platform: "android",
      arch: "arm64",
    })
    expect(android.ok).toBe(false)
  })

  test("PLATFORM_PACKAGE_NAMES covers every supported key", () => {
    expect(Object.keys(PLATFORM_PACKAGE_NAMES).sort()).toEqual(
      [...SUPPORTED_PLATFORM_KEYS].sort(),
    )
  })

  test("binaryRelativePathFor uses .exe only on Windows keys", () => {
    expect(binaryRelativePathFor("linux-x64")).toBe(BINARY_RELATIVE_PATH)
    expect(binaryRelativePathFor("darwin-arm64")).toBe(BINARY_RELATIVE_PATH)
    expect(binaryRelativePathFor("win32-x64")).toBe(
      WINDOWS_BINARY_RELATIVE_PATH,
    )
    expect(binaryRelativePathFor("win32-arm64")).toBe(
      WINDOWS_BINARY_RELATIVE_PATH,
    )
  })

  test("bun compile targets map 1:1 for supported platforms", () => {
    expect(bunCompileTarget("linux-x64")).toBe("bun-linux-x64")
    expect(bunCompileTarget("linux-arm64")).toBe("bun-linux-arm64")
    expect(bunCompileTarget("darwin-x64")).toBe("bun-darwin-x64")
    expect(bunCompileTarget("darwin-arm64")).toBe("bun-darwin-arm64")
    expect(bunCompileTarget("win32-x64")).toBe("bun-windows-x64")
    expect(bunCompileTarget("win32-arm64")).toBe("bun-windows-arm64")
  })

  test("launcher bin imports the shared select-platform pure seam", () => {
    expect(launcherSource).toContain('from "./select-platform.js"')
    expect(launcherSource).toContain("selectPlatformPackage")
    for (const name of Object.values(PLATFORM_PACKAGE_NAMES)) {
      expect(Object.values(PLATFORM_PACKAGE_NAMES)).toContain(name)
    }
  })
})
