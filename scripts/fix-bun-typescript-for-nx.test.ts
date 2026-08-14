import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"

const workspaceRoot = join(import.meta.dir, "..")
const nestedTypescript = join(
  workspaceRoot,
  "node_modules",
  ".bun",
  "node_modules",
  "typescript",
)

describe("fix-bun-typescript-for-nx", () => {
  it("keeps nested typescript classic and provides version.cjs for Nx", () => {
    const result = spawnSync(
      process.execPath,
      [join(workspaceRoot, "scripts/fix-bun-typescript-for-nx.mjs")],
      { cwd: workspaceRoot, encoding: "utf8" },
    )
    expect(result.status).toBe(0)

    const ts = createRequire(join(nestedTypescript, "package.json"))(".")
    expect(typeof ts.readConfigFile).toBe("function")

    const versionCjs = join(nestedTypescript, "lib", "version.cjs")
    expect(existsSync(versionCjs)).toBe(true)
    const version = createRequire(versionCjs)(versionCjs)
    expect(typeof version.version).toBe("string")
    expect(version.version.length).toBeGreaterThan(0)
    expect(version.versionMajorMinor).toMatch(/^\d+\.\d+$/)
  })

  it("runs from the pre-commit Nx steps so typescript-sync sees classic TypeScript", () => {
    const hk = readFileSync(join(workspaceRoot, "hk.pkl"), "utf8")
    const shim = "node scripts/fix-bun-typescript-for-nx.mjs"
    expect(hk.split(shim).length - 1).toBe(2)
  })
})
