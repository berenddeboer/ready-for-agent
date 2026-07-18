#!/usr/bin/env bun
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")
const clientRoot = resolve(workspaceRoot, "apps/harness/dist/client")
const outDir = join(appRoot, "src/generated")
const assetsOut = join(outDir, "client-assets.ts")
const versionOut = join(outDir, "version.ts")

const walkFiles = (root: string): string[] => {
  const results: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (entry.isFile()) {
        results.push(full)
      }
    }
  }
  visit(root)
  return results.sort((a, b) => a.localeCompare(b))
}

if (!statSync(clientRoot, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(
    `Missing harness client build at ${clientRoot}. Run harness:build first.`,
  )
  process.exit(1)
}

const files = walkFiles(clientRoot)
if (files.length === 0) {
  console.error(`No client assets found under ${clientRoot}`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })

const importLines: string[] = []
const mapLines: string[] = []
let shellImport: string | undefined

for (const [index, absolute] of files.entries()) {
  const relFromClient = relative(clientRoot, absolute).split("\\").join("/")
  const pathname = `/${relFromClient}`
  const importPath = relative(outDir, absolute).split("\\").join("/")
  const alias = `asset${index}`
  importLines.push(
    `import ${alias} from ${JSON.stringify(importPath)} with { type: "file" }`,
  )
  mapLines.push(`  ${JSON.stringify(pathname)}: ${alias} as unknown as string,`)
  if (relFromClient === "_shell.html") {
    shellImport = alias
  }
}

if (shellImport === undefined) {
  console.error("Client build is missing _shell.html")
  process.exit(1)
}

const assetsContent = `// @ts-nocheck
${importLines.join("\n")}

/** Embedded production UI files (pathname → Bun embedded file path). */
export const embeddedClientAssets: Readonly<Record<string, string>> = {
${mapLines.join("\n")}
}

/** SPA shell HTML embedded file path. */
export const embeddedShellHtmlPath: string = ${shellImport} as unknown as string
`

writeFileSync(assetsOut, assetsContent)

const packageJson = JSON.parse(
  readFileSync(join(appRoot, "package.json"), "utf8"),
) as { version?: string }
const version =
  typeof packageJson.version === "string" && packageJson.version.trim() !== ""
    ? packageJson.version.trim()
    : "0.0.0"

writeFileSync(
  versionOut,
  `/** Injected at compile/embed time from apps/ready-for-agent/package.json. */
export const READY_FOR_AGENT_VERSION = ${JSON.stringify(version)}
`,
)

console.log(
  `Wrote ${assetsOut} (${files.length} assets) and ${versionOut} (v${version})`,
)
