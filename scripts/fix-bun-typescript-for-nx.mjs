/**
 * Bun installs `@typescript/native` (npm:typescript@7) under the package name
 * `typescript`, which can occupy `node_modules/.bun/node_modules/typescript`.
 * Nested requires (e.g. Nx 23) then load TS 7's stub entry without
 * `readConfigFile` and fail project-graph construction.
 *
 * Classic TS is already linked at the workspace root as `typescript`
 * (`@typescript/typescript6`) and also as `typescript@6.0.2` in the bun
 * store. Replacing the nested shadow with that classic package keeps the
 * path Nx already resolved. Classic 6 does not ship `lib/version.cjs`,
 * which `@nx/js:typescript-sync` requires, so the shim writes a tiny
 * compatible stub. `@typescript/native` keeps its own scoped path.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const bunStore = join(root, "node_modules", ".bun")
const nestedTypescript = join(bunStore, "node_modules", "typescript")

const isUsableClassicTypescript = (packageRoot) => {
  if (!existsSync(join(packageRoot, "package.json"))) return false
  try {
    const ts = createRequire(join(packageRoot, "package.json"))(".")
    return typeof ts.readConfigFile === "function"
  } catch {
    return false
  }
}

const findClassicTypescript = () => {
  if (!existsSync(bunStore)) return undefined
  for (const entry of readdirSync(bunStore)) {
    if (!entry.startsWith("typescript@")) continue
    const candidate = join(bunStore, entry, "node_modules", "typescript")
    if (isUsableClassicTypescript(candidate)) return candidate
  }
  return undefined
}

const versionCjsPath = (packageRoot) => join(packageRoot, "lib", "version.cjs")

const ensureVersionCjs = (packageRoot) => {
  const dest = versionCjsPath(packageRoot)
  if (existsSync(dest)) return false
  const pkgPath = join(packageRoot, "package.json")
  const raw = JSON.parse(readFileSync(pkgPath, "utf8"))
  const version = typeof raw.version === "string" ? raw.version : "6.0.2"
  const [major = "6", minor = "0"] = version.split(".")
  writeFileSync(
    dest,
    `const { version } = require("../package.json");
exports.version = version;
exports.versionMajorMinor = ${JSON.stringify(`${major}.${minor}`)};
`,
  )
  return true
}

if (isUsableClassicTypescript(nestedTypescript)) {
  if (ensureVersionCjs(nestedTypescript)) {
    console.log(
      "fix-bun-typescript-for-nx: wrote lib/version.cjs for Nx typescript-sync",
    )
  }
  process.exit(0)
}

if (existsSync(nestedTypescript)) {
  const stat = lstatSync(nestedTypescript)
  rmSync(nestedTypescript, { recursive: !stat.isSymbolicLink(), force: true })
}

const classicTypescript = findClassicTypescript()
if (classicTypescript === undefined) {
  console.error(
    "fix-bun-typescript-for-nx: classic typescript is missing; run bun install",
  )
  process.exit(1)
}

symlinkSync(
  relative(dirname(nestedTypescript), classicTypescript),
  nestedTypescript,
)
ensureVersionCjs(nestedTypescript)
console.log(
  "fix-bun-typescript-for-nx: pointed nested typescript at classic TypeScript so Nx keeps readConfigFile",
)
