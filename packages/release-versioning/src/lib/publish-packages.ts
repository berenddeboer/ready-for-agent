import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import semver from "semver"

export const LAUNCHER_PACKAGE_NAME = "ready-for-agent"

export const PLATFORM_PACKAGE_NAMES = [
  "ready-for-agent-linux-x64",
  "ready-for-agent-linux-arm64",
  "ready-for-agent-darwin-x64",
  "ready-for-agent-darwin-arm64",
] as const

export type PlatformPackageName = (typeof PLATFORM_PACKAGE_NAMES)[number]

export type JsonObject = Record<string, unknown>

/** Shared npm README for platform binary packages (not installed alone). */
export const PLATFORM_PACKAGE_README = `# ready-for-agent platform binary

This package ships a **platform-specific binary** used as an optional dependency
of [\`ready-for-agent\`](https://www.npmjs.com/package/ready-for-agent).

It is **not meant to be installed on its own**. Install and use the main
package instead:

\`\`\`bash
npm install -g ready-for-agent
# or
npx ready-for-agent@latest
\`\`\`

- npm: https://www.npmjs.com/package/ready-for-agent
- GitHub: https://github.com/berenddeboer/ready-for-agent
`

export function assertPublishVersion(version: string): string {
  const cleaned = semver.clean(version)
  if (cleaned === null || cleaned !== version) {
    throw new Error(
      `Invalid publish version: ${version}. Expected a clean semver string (no leading v).`,
    )
  }
  return cleaned
}

/**
 * Sets the launcher package version and pins optionalDependencies to the same
 * version so npm installs matching platform packages.
 */
export function applyVersionToLauncherPackageJson(
  pkg: JsonObject,
  version: string,
): JsonObject {
  const v = assertPublishVersion(version)
  const optionalDependencies: Record<string, string> = {
    ...Object.fromEntries(
      PLATFORM_PACKAGE_NAMES.map((name) => [name, v] as const),
    ),
  }

  return {
    ...pkg,
    version: v,
    optionalDependencies,
  }
}

export function applyVersionToPlatformPackageJson(
  pkg: JsonObject,
  version: string,
): JsonObject {
  const v = assertPublishVersion(version)
  return {
    ...pkg,
    version: v,
  }
}

/**
 * Manifest written for npm publish of the launcher: drops monorepo-only
 * dependencies (workspace:*, Effect, etc.) so the published package is only the
 * Node launcher + platform optionalDependencies.
 */
export function launcherManifestForNpmPublish(
  pkg: JsonObject,
  version: string,
): JsonObject {
  const withVersion = applyVersionToLauncherPackageJson(pkg, version)
  const {
    dependencies: _dependencies,
    devDependencies: _devDependencies,
    scripts: _scripts,
    private: _private,
    ...publishable
  } = withVersion

  return publishable
}

export type PublishPackagePath = {
  name: string
  packageJsonRelativePath: string
  kind: "launcher" | "platform"
}

export const PUBLISH_PACKAGE_PATHS: readonly PublishPackagePath[] = [
  {
    name: LAUNCHER_PACKAGE_NAME,
    packageJsonRelativePath: "apps/ready-for-agent/package.json",
    kind: "launcher",
  },
  ...PLATFORM_PACKAGE_NAMES.map(
    (name): PublishPackagePath => ({
      name,
      packageJsonRelativePath: `packages/${name}/package.json`,
      kind: "platform",
    }),
  ),
]

export const LAUNCHER_PACKAGE_DIR = "apps/ready-for-agent"

/**
 * Stages npm-facing README files for publish:
 * - Launcher gets the repository root product README (install/usage), not the
 *   monorepo architecture notes under apps/ready-for-agent/README.md.
 * - Each platform package gets the shared platform-binary stub.
 */
export function preparePublishPackageReadmes(workspaceRoot: string): {
  launcherReadmePath: string
  platformReadmePaths: string[]
} {
  const launcherReadmePath = join(
    workspaceRoot,
    LAUNCHER_PACKAGE_DIR,
    "README.md",
  )
  copyFileSync(join(workspaceRoot, "README.md"), launcherReadmePath)

  const platformReadmePaths = PLATFORM_PACKAGE_NAMES.map((name) => {
    const path = join(workspaceRoot, "packages", name, "README.md")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, PLATFORM_PACKAGE_README)
    return path
  })

  return { launcherReadmePath, platformReadmePaths }
}
