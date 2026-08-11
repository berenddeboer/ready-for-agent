import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
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

/** Product version label shown in UI chrome (`v<semver>`). */
export const productVersionLabel = (version: string): string => `v${version}`

/**
 * Semver (optional pre-release) as printed in masthead title /
 * `Ready for Agent v…`.
 */
export const PRODUCT_VERSION_IN_TEXT_PATTERN =
  /Ready for Agent v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/

/**
 * Fail-fast guard for release embeds: harness client dist must already bake the
 * launcher product version (not a stale Nx-cached `v0.0.0` UI).
 */
export const assertClientDistMatchesProductVersion = (
  clientRoot: string,
  version: string,
): void => {
  const label = productVersionLabel(version)
  const titleNeedle = `Ready for Agent ${label}`
  const shellPath = join(clientRoot, "_shell.html")
  let shell: string
  try {
    shell = readFileSync(shellPath, "utf8")
  } catch {
    throw new Error(
      `Harness client shell missing at ${shellPath}. Run harness:build first.`,
    )
  }
  if (!shell.includes(titleNeedle)) {
    const found = shell.match(PRODUCT_VERSION_IN_TEXT_PATTERN)?.[0]
    throw new Error(
      `Harness client shell does not embed product version ${JSON.stringify(label)}` +
        (found === undefined
          ? " (no Ready for Agent v… title found)"
          : ` (found ${JSON.stringify(found)})`) +
        `. harness:build likely used a stale cache; ensure package.json version is an input to harness:build.`,
    )
  }

  // Minified client bundles keep the label as a string literal (`v1.2.3`).
  const assetsDir = join(clientRoot, "assets")
  let assetNames: string[] = []
  try {
    assetNames = readdirSync(assetsDir).filter((name) => name.endsWith(".js"))
  } catch {
    throw new Error(`Harness client assets missing under ${assetsDir}`)
  }
  const assetHasLabel = assetNames.some((name) =>
    readFileSync(join(assetsDir, name), "utf8").includes(label),
  )
  if (!assetHasLabel) {
    throw new Error(
      `No harness client JS asset contains ${JSON.stringify(label)}; UI masthead would show a stale version.`,
    )
  }
}

/**
 * Parse masthead product version from production shell HTML.
 * Prefers the title attribute so SSR `<!-- -->` splits between RFA and v… do
 * not break the check.
 */
export const parseMastheadProductVersion = (
  html: string,
): string | undefined => {
  const match = html.match(PRODUCT_VERSION_IN_TEXT_PATTERN)
  return match?.[1]
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
