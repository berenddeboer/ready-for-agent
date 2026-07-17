import { describe, expect, it } from "vitest"
import {
  PLATFORM_PACKAGE_NAMES,
  applyVersionToLauncherPackageJson,
  applyVersionToPlatformPackageJson,
  assertPublishVersion,
  launcherManifestForNpmPublish,
} from "../src/lib/publish-packages.js"

describe("assertPublishVersion", () => {
  it("accepts clean semver", () => {
    expect(assertPublishVersion("0.1.0")).toBe("0.1.0")
  })

  it("rejects v-prefixed versions", () => {
    expect(() => assertPublishVersion("v0.1.0")).toThrow(
      /Invalid publish version/,
    )
  })

  it("rejects non-semver", () => {
    expect(() => assertPublishVersion("not-a-version")).toThrow(
      /Invalid publish version/,
    )
  })
})

describe("applyVersionToLauncherPackageJson", () => {
  it("sets version and pins all platform optionalDependencies", () => {
    const next = applyVersionToLauncherPackageJson(
      {
        name: "ready-for-agent",
        version: "0.0.0",
        optionalDependencies: {
          "ready-for-agent-linux-x64": "0.0.0",
        },
        dependencies: {
          effect: "^4.0.0",
        },
      },
      "1.2.3",
    )

    expect(next.version).toBe("1.2.3")
    expect(next.optionalDependencies).toEqual(
      Object.fromEntries(PLATFORM_PACKAGE_NAMES.map((name) => [name, "1.2.3"])),
    )
    expect(next.dependencies).toEqual({ effect: "^4.0.0" })
  })
})

describe("applyVersionToPlatformPackageJson", () => {
  it("sets version only", () => {
    const next = applyVersionToPlatformPackageJson(
      {
        name: "ready-for-agent-linux-x64",
        version: "0.0.0",
        os: ["linux"],
      },
      "0.1.0",
    )

    expect(next).toEqual({
      name: "ready-for-agent-linux-x64",
      version: "0.1.0",
      os: ["linux"],
    })
  })
})

describe("launcherManifestForNpmPublish", () => {
  it("strips monorepo-only fields and keeps the public surface", () => {
    const next = launcherManifestForNpmPublish(
      {
        name: "ready-for-agent",
        version: "0.0.0",
        description: "Ready for Agent",
        license: "MIT",
        type: "module",
        bin: { "ready-for-agent": "./bin/ready-for-agent.js" },
        files: ["bin/ready-for-agent.js", "bin/select-platform.js"],
        scripts: { typecheck: "tsc" },
        dependencies: {
          "@ready-for-agent/graphql-client": "workspace:*",
          effect: "^4.0.0",
        },
        devDependencies: { "@types/bun": "^1.3.0" },
        optionalDependencies: {
          "ready-for-agent-linux-x64": "0.0.0",
        },
        engines: { node: ">=20" },
      },
      "0.1.0",
    )

    expect(next).toEqual({
      name: "ready-for-agent",
      version: "0.1.0",
      description: "Ready for Agent",
      license: "MIT",
      type: "module",
      bin: { "ready-for-agent": "./bin/ready-for-agent.js" },
      files: ["bin/ready-for-agent.js", "bin/select-platform.js"],
      optionalDependencies: Object.fromEntries(
        PLATFORM_PACKAGE_NAMES.map((name) => [name, "0.1.0"]),
      ),
      engines: { node: ">=20" },
    })
    expect(next).not.toHaveProperty("dependencies")
    expect(next).not.toHaveProperty("devDependencies")
    expect(next).not.toHaveProperty("scripts")
  })
})
