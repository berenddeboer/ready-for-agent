import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")

const launcherVersionModuleContent = (version: string): string =>
  `/** Injected at build time from apps/ready-for-agent/package.json. */
export const READY_FOR_AGENT_VERSION = ${JSON.stringify(version)}
`

const harnessVersionModuleContent = (version: string): string =>
  `/** Injected at build time from apps/ready-for-agent/package.json. */
export const READY_FOR_AGENT_VERSION = ${JSON.stringify(version)}
export const READY_FOR_AGENT_VERSION_LABEL = ${JSON.stringify(`v${version}`)}
`

export const readLauncherVersion = (): string => {
  const packageJson = JSON.parse(
    readFileSync(join(appRoot, "package.json"), "utf8"),
  ) as { version?: string }
  return typeof packageJson.version === "string" &&
    packageJson.version.trim() !== ""
    ? packageJson.version.trim()
    : "0.0.0"
}

/** Writes the canonical product version for CLI, Harness server, and UI. */
export const writeReadyForAgentVersionFiles = (
  version: string = readLauncherVersion(),
): { readonly version: string; readonly paths: readonly string[] } => {
  const launcherPath = join(appRoot, "src/generated/version.ts")
  const harnessPath = join(
    workspaceRoot,
    "apps/harness/src/generated/version.ts",
  )
  const paths = [launcherPath, harnessPath]
  mkdirSync(dirname(launcherPath), { recursive: true })
  mkdirSync(dirname(harnessPath), { recursive: true })
  writeFileSync(launcherPath, launcherVersionModuleContent(version))
  writeFileSync(harnessPath, harnessVersionModuleContent(version))
  return { version, paths }
}

if (import.meta.main) {
  const { version, paths } = writeReadyForAgentVersionFiles()
  console.log(
    `Wrote Ready for Agent version v${version} to ${paths.join(" and ")}`,
  )
}
