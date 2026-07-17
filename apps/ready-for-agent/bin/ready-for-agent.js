#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { selectPlatformPackage } from "./select-platform.js"

const require = createRequire(import.meta.url)

const selection = selectPlatformPackage({
  platform: process.platform,
  arch: process.arch,
})

if (!selection.ok) {
  console.error(selection.message)
  process.exit(1)
}

/**
 * @param {string} packageName
 * @param {string} binaryRelativePath
 * @returns {string | undefined}
 */
const resolveInstalledBinary = (packageName, binaryRelativePath) => {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`)
    return join(dirname(packageJsonPath), binaryRelativePath)
  } catch {
    return undefined
  }
}

const binaryPath = resolveInstalledBinary(
  selection.packageName,
  selection.binaryRelativePath,
)

if (binaryPath === undefined) {
  console.error(
    `Could not find the ${selection.packageName} package, which is required for ${selection.platformKey}. ` +
      `Reinstall ready-for-agent without --no-optional so npm can install the matching platform package.`,
  )
  process.exit(1)
}

if (!existsSync(binaryPath)) {
  console.error(
    `The ${selection.packageName} package is installed but the binary is missing at ${binaryPath}. ` +
      `Reinstall the package, or in a monorepo checkout run: bunx nx run ready-for-agent:compile`,
  )
  process.exit(1)
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status === null ? 1 : result.status)
