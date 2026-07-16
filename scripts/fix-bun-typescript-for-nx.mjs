/**
 * Bun installs `@typescript/native` (npm:typescript@7) under the package name
 * `typescript`, which can occupy `node_modules/.bun/node_modules/typescript`.
 * Nested requires (e.g. Nx 23) then load TS 7's stub entry without
 * `readConfigFile` and fail project-graph construction.
 *
 * Classic TS is already linked at the workspace root as `typescript`
 * (`@typescript/typescript6`). Removing the nested shadow makes Node continue
 * to that root install. `@typescript/native` keeps its own scoped path.
 */
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const nestedTypescript = join(
  root,
  "node_modules",
  ".bun",
  "node_modules",
  "typescript",
)

if (!existsSync(nestedTypescript)) process.exit(0)

const packageJsonPath = join(nestedTypescript, "package.json")
if (!existsSync(packageJsonPath)) process.exit(0)

const { version, name } = JSON.parse(readFileSync(packageJsonPath, "utf8"))
const requireFromNested = createRequire(join(nestedTypescript, "package.json"))

let hasReadConfigFile = false
try {
  const ts = requireFromNested(".")
  hasReadConfigFile = typeof ts.readConfigFile === "function"
} catch {
  hasReadConfigFile = false
}

if (name === "typescript" && !hasReadConfigFile) {
  const stat = lstatSync(nestedTypescript)
  rmSync(nestedTypescript, { recursive: !stat.isSymbolicLink(), force: true })
  console.log(
    `fix-bun-typescript-for-nx: removed nested typescript@${version} shadow so Nx can use classic TypeScript`,
  )
}
