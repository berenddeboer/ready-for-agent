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
