import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type AliasOptions, defineConfig } from "vitest/config"

const harnessRoot = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(harnessRoot, "../..")

type PackageExports = Record<
  string,
  string | { "@ready-for-agent/source"?: string }
>

/**
 * Map each workspace package export that exposes `@ready-for-agent/source` to
 * its TypeScript entry so Vitest does not need built `dist/`. Mirrors the
 * export condition Bun/Nx use for monorepo source runs.
 *
 * Uses exact-match regex aliases so `@scope/name/test` is not resolved as
 * `@scope/name` + `/test` on the file path.
 */
const workspacePackageAlias = (): AliasOptions => {
  const entries: Array<{ find: RegExp; replacement: string }> = []
  for (const group of ["packages", "apps"] as const) {
    const groupDir = join(workspaceRoot, group)
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const packageDir = join(groupDir, entry.name)
      const packageJsonPath = join(packageDir, "package.json")
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          name?: string
          exports?: PackageExports
        }
        if (pkg.name === undefined || pkg.exports === undefined) continue
        for (const [exportPath, target] of Object.entries(pkg.exports)) {
          if (typeof target === "string" || target === undefined) continue
          const source = target["@ready-for-agent/source"]
          if (source === undefined) continue
          const aliasKey =
            exportPath === "."
              ? pkg.name
              : `${pkg.name}/${exportPath.replace(/^\.\//, "")}`
          entries.push({
            find: new RegExp(
              `^${aliasKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            ),
            replacement: join(packageDir, source),
          })
        }
      } catch {
        // skip packages without a resolvable package.json
      }
    }
  }
  // Longer import ids first so nested export paths win over package roots.
  entries.sort((a, b) => b.find.source.length - a.find.source.length)
  return entries
}

/**
 * Effect-first unit suites that import from `@effect/vitest`.
 * Remaining Harness tests still run under `bun test` (see scripts/run-unit-tests.sh).
 */
export default defineConfig({
  resolve: {
    alias: workspacePackageAlias(),
    conditions: ["@ready-for-agent/source", "import", "module", "default"],
  },
  test: {
    include: [
      "test/job-worker.test.ts",
      "test/keymaxxer-github-layer.test.ts",
      "test/keymaxxer-gitlab-layer.test.ts",
      "test/keymaxxer-azure-devops-layer.test.ts",
      "test/ambient-github-layer.test.ts",
      "test/github-operation-coordinator.test.ts",
      "test/ambient-gitlab-layer.test.ts",
      "test/application-config.test.ts",
      "test/application-runtime-disposal.test.ts",
      "test/production-sse-idle-timeout.test.ts",
    ],
    // production-sse-idle-timeout is intentionally long; run via vitest when included.
    testTimeout: 30_000,
  },
})
