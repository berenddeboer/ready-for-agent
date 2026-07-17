#!/usr/bin/env bun
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BINARY_RELATIVE_PATH,
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
] as const

type SupportedPlatformKey = (typeof knownKeys)[number]

const isSupportedPlatformKey = (value: string): value is SupportedPlatformKey =>
  (knownKeys as ReadonlyArray<string>).includes(value)

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

const selection = selectPlatformPackage({
  platform: platformKey.startsWith("darwin") ? "darwin" : "linux",
  arch: platformKey.endsWith("arm64") ? "arm64" : "x64",
})
if (!selection.ok) {
  console.error(selection.message)
  process.exit(1)
}

const outfile = join(
  workspaceRoot,
  "packages",
  selection.packageName,
  BINARY_RELATIVE_PATH,
)
mkdirSync(dirname(outfile), { recursive: true })

const target = bunCompileTarget(platformKey)
const args = [
  "build",
  "--compile",
  `--target=${target}`,
  `--outfile=${outfile}`,
  "--conditions=@ready-for-agent/source",
  entrypoint,
]

console.log(`Compiling ${platformKey} → ${outfile}`)
const result = Bun.spawnSync(["bun", ...args], {
  cwd: workspaceRoot,
  stdio: ["inherit", "inherit", "inherit"],
})

if (result.exitCode !== 0) {
  process.exit(result.exitCode ?? 1)
}

console.log(`Wrote ${outfile}`)
