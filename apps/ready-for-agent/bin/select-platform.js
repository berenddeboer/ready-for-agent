/**
 * Pure platform → package selection for the ready-for-agent launcher.
 * Node-compatible; no Bun APIs. Unit-tested from select-platform.test.ts.
 */

/** @typedef {"linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64"} SupportedPlatformKey */

/**
 * @typedef {object} PlatformPackageSelection
 * @property {true} ok
 * @property {SupportedPlatformKey} platformKey
 * @property {string} packageName
 * @property {string} binaryRelativePath
 */

/**
 * @typedef {object} UnsupportedPlatform
 * @property {false} ok
 * @property {string} message
 */

/** @type {ReadonlyArray<SupportedPlatformKey>} */
export const SUPPORTED_PLATFORM_KEYS = Object.freeze([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
])

/** @type {Readonly<Record<SupportedPlatformKey, string>>} */
export const PLATFORM_PACKAGE_NAMES = Object.freeze({
  "linux-x64": "ready-for-agent-linux-x64",
  "linux-arm64": "ready-for-agent-linux-arm64",
  "darwin-x64": "ready-for-agent-darwin-x64",
  "darwin-arm64": "ready-for-agent-darwin-arm64",
})

export const BINARY_RELATIVE_PATH = "bin/ready-for-agent"

/**
 * @param {string} arch
 * @returns {string | undefined}
 */
const normalizeArch = (arch) => {
  if (arch === "x64" || arch === "x86_64" || arch === "amd64") return "x64"
  if (arch === "arm64" || arch === "aarch64") return "arm64"
  return undefined
}

/**
 * @param {string} platform
 * @returns {string | undefined}
 */
const normalizeOs = (platform) => {
  if (platform === "linux") return "linux"
  if (platform === "darwin") return "darwin"
  return undefined
}

/**
 * @param {{ platform: string, arch: string }} host
 * @returns {PlatformPackageSelection | UnsupportedPlatform}
 */
export const selectPlatformPackage = (host) => {
  const os = normalizeOs(host.platform)
  const arch = normalizeArch(host.arch)

  if (os === undefined || arch === undefined) {
    return {
      ok: false,
      message: unsupportedPlatformMessage(host.platform, host.arch),
    }
  }

  /** @type {string} */
  const platformKey = `${os}-${arch}`
  if (!Object.hasOwn(PLATFORM_PACKAGE_NAMES, platformKey)) {
    return {
      ok: false,
      message: unsupportedPlatformMessage(host.platform, host.arch),
    }
  }

  /** @type {SupportedPlatformKey} */
  const key = /** @type {SupportedPlatformKey} */ (platformKey)
  return {
    ok: true,
    platformKey: key,
    packageName: PLATFORM_PACKAGE_NAMES[key],
    binaryRelativePath: BINARY_RELATIVE_PATH,
  }
}

/**
 * @param {string} platform
 * @param {string} arch
 * @returns {string}
 */
export const unsupportedPlatformMessage = (platform, arch) => {
  const supported = SUPPORTED_PLATFORM_KEYS.join(", ")
  return (
    `ready-for-agent does not support this platform (${platform}/${arch}). ` +
    `Supported platforms: ${supported}. ` +
    `Windows is not supported in v1.`
  )
}

/**
 * Bun compile --target value for a supported platform key.
 * @param {SupportedPlatformKey} platformKey
 * @returns {string}
 */
export const bunCompileTarget = (platformKey) => {
  switch (platformKey) {
    case "linux-x64":
      return "bun-linux-x64"
    case "linux-arm64":
      return "bun-linux-arm64"
    case "darwin-x64":
      return "bun-darwin-x64"
    case "darwin-arm64":
      return "bun-darwin-arm64"
    default: {
      const _exhaustive = /** @type {never} */ (platformKey)
      return _exhaustive
    }
  }
}
