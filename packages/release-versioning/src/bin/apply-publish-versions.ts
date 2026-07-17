import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  type JsonObject,
  PUBLISH_PACKAGE_PATHS,
  applyVersionToLauncherPackageJson,
  applyVersionToPlatformPackageJson,
  assertPublishVersion,
  launcherManifestForNpmPublish,
} from "../lib/publish-packages.js"

const args = process.argv.slice(2)
const forPublish = args.includes("--for-publish")
const positional = args.filter((arg) => arg !== "--for-publish")
const versionArg = positional[0]
const cwd = resolve(positional[1] ?? process.cwd())

if (versionArg === undefined || versionArg === "") {
  console.error(
    "Usage: apply-publish-versions <version> [workspaceRoot] [--for-publish]",
  )
  process.exitCode = 1
} else {
  try {
    const version = assertPublishVersion(versionArg)

    for (const entry of PUBLISH_PACKAGE_PATHS) {
      const path = join(cwd, entry.packageJsonRelativePath)
      const raw = JSON.parse(readFileSync(path, "utf8")) as JsonObject
      const next =
        entry.kind === "launcher"
          ? forPublish
            ? launcherManifestForNpmPublish(raw, version)
            : applyVersionToLauncherPackageJson(raw, version)
          : applyVersionToPlatformPackageJson(raw, version)

      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
      process.stdout.write(`${entry.name}@${version} → ${path}\n`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
