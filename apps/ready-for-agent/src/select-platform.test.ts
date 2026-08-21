import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BINARY_RELATIVE_PATH,
  PLATFORM_PACKAGE_NAMES,
  SUPPORTED_PLATFORM_KEYS,
  WINDOWS_BINARY_RELATIVE_PATH,
  binaryRelativePathFor,
  binarySpawnFailureMessage,
  bunCompileTarget,
  selectPlatformPackage,
  unsupportedPlatformMessage,
} from "../bin/select-platform.js"
import { describe, expect, test } from "bun:test"

const binDir = dirname(fileURLToPath(import.meta.url))
const linuxX64Test =
  process.platform === "linux" && process.arch === "x64" ? test : test.skip

// Piped core_pattern still records ulimit -c 0 crashes in coredumpctl.
// PR_SET_DUMPABLE 0 makes systemd-coredump ignore the process.
const SIGILL_NONDUMPABLE_C = [
  "#include <signal.h>",
  "#include <sys/prctl.h>",
  "int main(void) {",
  "  prctl(PR_SET_DUMPABLE, 0);",
  "  raise(SIGILL);",
  "}",
  "",
].join("\n")

const writeNondumpableSigillBinary = (outputPath: string): void => {
  const cc = Bun.which("cc") ?? Bun.which("gcc")
  if (cc === null) {
    throw new Error("cc is required to build the SIGILL launcher fixture")
  }
  const compiled = spawnSync(cc, ["-o", outputPath, "-x", "c", "-"], {
    encoding: "utf8",
    input: SIGILL_NONDUMPABLE_C,
  })
  if (compiled.status !== 0) {
    throw new Error(
      `failed to compile SIGILL launcher fixture: ${compiled.stderr}`,
    )
  }
}

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

  test("bun compile targets map supported platforms", () => {
    expect(bunCompileTarget("linux-x64")).toBe("bun-linux-x64-baseline")
    expect(bunCompileTarget("linux-arm64")).toBe("bun-linux-arm64")
    expect(bunCompileTarget("darwin-x64")).toBe("bun-darwin-x64")
    expect(bunCompileTarget("darwin-arm64")).toBe("bun-darwin-arm64")
    expect(bunCompileTarget("win32-x64")).toBe("bun-windows-x64")
    expect(bunCompileTarget("win32-arm64")).toBe("bun-windows-arm64")
  })

  test("binarySpawnFailureMessage names SIGILL and the linux-x64 baseline target", () => {
    const message = binarySpawnFailureMessage("linux-x64", {
      error: undefined,
      signal: "SIGILL",
      status: null,
    })
    expect(message).toContain("SIGILL")
    expect(message).toContain("bun-linux-x64-baseline")
    expect(message).toContain("likely")
    expect(message).toContain("SSE4.2")
  })

  test("binarySpawnFailureMessage does not diagnose SIGILL on other platforms", () => {
    expect(
      binarySpawnFailureMessage("linux-arm64", {
        error: undefined,
        signal: "SIGILL",
        status: null,
      }),
    ).toBeUndefined()
  })

  test("binarySpawnFailureMessage prefers spawn error text over signal", () => {
    expect(
      binarySpawnFailureMessage("darwin-arm64", {
        error: new Error("spawn EACCES"),
        signal: null,
        status: null,
      }),
    ).toBe("spawn EACCES")
  })

  test("binarySpawnFailureMessage is silent on a normal exit", () => {
    expect(
      binarySpawnFailureMessage("linux-x64", {
        error: undefined,
        signal: null,
        status: 2,
      }),
    ).toBeUndefined()
    expect(
      binarySpawnFailureMessage("linux-x64", {
        error: undefined,
        signal: "SIGTERM",
        status: null,
      }),
    ).toBeUndefined()
  })

  linuxX64Test("launcher reports a signaled platform binary", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "rfa-sigill-launcher-"))
    try {
      const launcherRoot = join(fixtureRoot, "ready-for-agent")
      const launcherBin = join(launcherRoot, "bin")
      const platformRoot = join(
        launcherRoot,
        "node_modules",
        "ready-for-agent-linux-x64",
      )
      const platformBin = join(platformRoot, BINARY_RELATIVE_PATH)

      mkdirSync(launcherBin, { recursive: true })
      mkdirSync(dirname(platformBin), { recursive: true })
      copyFileSync(
        join(binDir, "../bin/ready-for-agent.js"),
        join(launcherBin, "ready-for-agent.js"),
      )
      copyFileSync(
        join(binDir, "../bin/select-platform.js"),
        join(launcherBin, "select-platform.js"),
      )
      writeFileSync(
        join(launcherRoot, "package.json"),
        JSON.stringify({ type: "module" }),
      )
      writeFileSync(
        join(platformRoot, "package.json"),
        JSON.stringify({ name: "ready-for-agent-linux-x64" }),
      )
      writeNondumpableSigillBinary(platformBin)
      chmodSync(platformBin, 0o755)

      const node = Bun.which("node")
      if (node === null) throw new Error("node is required for launcher tests")
      const result = spawnSync(
        node,
        [join(launcherBin, "ready-for-agent.js")],
        {
          encoding: "utf8",
        },
      )

      expect(result.status).toBe(1)
      expect(result.signal).toBeNull()
      expect(result.stderr).toContain("SIGILL")
      expect(result.stderr).toContain("bun-linux-x64-baseline")
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })
})
