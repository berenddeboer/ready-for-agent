#!/usr/bin/env bun
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  binaryRelativePathFor,
  bunCompileTarget,
  selectPlatformPackage,
} from "../bin/select-platform.js"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")
const entrypoint = join(appRoot, "src/main.ts")

const knownKeys = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
] as const

type SupportedPlatformKey = (typeof knownKeys)[number]

const isSupportedPlatformKey = (value: string): value is SupportedPlatformKey =>
  (knownKeys as ReadonlyArray<string>).includes(value)

/**
 * Map a platform key back to process.platform / process.arch for selection.
 * Keys are always `{os}-{arch}` with os in {linux,darwin,win32}.
 */
const hostFromPlatformKey = (
  platformKey: SupportedPlatformKey,
): { platform: string; arch: string } => {
  if (platformKey.startsWith("win32-")) {
    return {
      platform: "win32",
      arch: platformKey.endsWith("arm64") ? "arm64" : "x64",
    }
  }
  if (platformKey.startsWith("darwin-")) {
    return {
      platform: "darwin",
      arch: platformKey.endsWith("arm64") ? "arm64" : "x64",
    }
  }
  return {
    platform: "linux",
    arch: platformKey.endsWith("arm64") ? "arm64" : "x64",
  }
}

const arg = process.argv[2]

const platformKey: SupportedPlatformKey = (() => {
  if (arg === undefined || arg === "host") {
    const hostSelection = selectPlatformPackage({
      platform: process.platform,
      arch: process.arch,
    })
    if (!hostSelection.ok) {
      console.error(hostSelection.message)
      process.exit(1)
    }
    return hostSelection.platformKey
  }
  if (!isSupportedPlatformKey(arg)) {
    console.error(
      `Unknown platform key ${arg}. Use host or one of: ${knownKeys.join(", ")}`,
    )
    process.exit(1)
  }
  return arg
})()

const selection = selectPlatformPackage(hostFromPlatformKey(platformKey))
if (!selection.ok) {
  console.error(selection.message)
  process.exit(1)
}

const outfile = join(
  workspaceRoot,
  "packages",
  selection.packageName,
  binaryRelativePathFor(platformKey),
)
mkdirSync(dirname(outfile), { recursive: true })

const compileWithTarget = (target: string) => {
  const args = [
    "build",
    "--compile",
    `--target=${target}`,
    `--outfile=${outfile}`,
    "--conditions=@ready-for-agent/source",
    entrypoint,
  ]
  console.log(`Compiling ${platformKey} (${target}) → ${outfile}`)
  return Bun.spawnSync([process.execPath, ...args], {
    cwd: workspaceRoot,
    stdout: "inherit",
    stderr: "pipe",
  })
}

const writeSpawnStderr = (result: ReturnType<typeof Bun.spawnSync>) => {
  const stderr = result.stderr
  if (stderr instanceof Uint8Array && stderr.byteLength > 0) {
    process.stderr.write(stderr)
  }
}

const preferredTarget = bunCompileTarget(platformKey)
let result = compileWithTarget(preferredTarget)
if (result.exitCode !== 0 && preferredTarget === "bun-linux-x64-baseline") {
  const stderrText =
    result.stderr instanceof Uint8Array
      ? new TextDecoder().decode(result.stderr)
      : ""
  if (stderrText.includes("is not available for download")) {
    writeSpawnStderr(result)
    console.warn(
      `Preferred target ${preferredTarget} is not available; retrying bun-linux-x64`,
    )
    result = compileWithTarget("bun-linux-x64")
  }
}

if (result.exitCode !== 0) {
  writeSpawnStderr(result)
  process.exit(result.exitCode ?? 1)
}

console.log(`Wrote ${outfile}`)
