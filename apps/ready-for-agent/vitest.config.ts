import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type AliasOptions, defineConfig } from "vitest/config"

const appRoot = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(appRoot, "../..")

type PackageExports = Record<
  string,
  string | { "@ready-for-agent/source"?: string }
>

const workspacePackageAlias = (): AliasOptions => {
  const entries: Array<{ find: RegExp; replacement: string }> = []
  for (const group of ["packages", "apps"] as const) {
    const groupDir = join(workspaceRoot, group)
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const packageDir = join(groupDir, entry.name)
      try {
        const pkg = JSON.parse(
          readFileSync(join(packageDir, "package.json"), "utf8"),
        ) as { name?: string; exports?: PackageExports }
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
        // skip
      }
    }
  }
  entries.sort((a, b) => b.find.source.length - a.find.source.length)
  return entries
}

const clientAssetsStub = join(appRoot, "test/stubs/client-assets.ts")

/**
 * Effect suites under this package use `@effect/vitest`. Pure non-Effect tests
 * remain on `bun test` via the project test target.
 */
export default defineConfig({
  plugins: [
    {
      name: "stub-embedded-client-assets",
      enforce: "pre",
      // generate-embed writes Bun `with { type: "file" }` imports of harness HTML;
      // Vitest must not parse those as modules. Match relative and absolute ids.
      resolveId(source) {
        const normalized = source.replaceAll("\\", "/")
        if (
          normalized.endsWith("generated/client-assets.ts") ||
          normalized.endsWith("generated/client-assets")
        ) {
          return clientAssetsStub
        }
        return undefined
      },
    },
  ],
  resolve: {
    alias: workspacePackageAlias(),
    conditions: ["@ready-for-agent/source", "import", "module", "default"],
  },
  test: {
    include: ["src/cli.test.ts", "src/services/application-config.test.ts"],
  },
})
