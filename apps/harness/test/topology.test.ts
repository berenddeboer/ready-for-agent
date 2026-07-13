import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"

type Target = {
  continuous?: boolean
  dependsOn?: unknown[]
  options?: { command?: string }
}

const readJson = async <A>(relativePath: string): Promise<A> =>
  JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8"),
  ) as A

describe("single application server topology", () => {
  test("attaches the development-only sidecar to harness:dev", async () => {
    const harness = await readJson<{ targets: Record<string, Target> }>(
      "../project.json",
    )
    const sidecar = await readJson<{ targets: Record<string, Target> }>(
      "../../keymaxxer-sidecar/project.json",
    )

    expect(sidecar.targets.serve?.continuous).toBe(true)
    expect(harness.targets.dev?.dependsOn).toContainEqual({
      projects: ["keymaxxer-sidecar"],
      target: "serve",
    })
    expect(harness.targets.dev?.options?.command).toContain(
      "export KEYMAXXER_SIDECAR_URL",
    )
    expect(harness.targets.dev?.options?.command).toContain(
      "export SQLITE_DATABASE_PATH",
    )
    expect(harness.targets.start?.dependsOn).not.toContainEqual({
      projects: ["keymaxxer-sidecar"],
      target: "serve",
    })
    expect(harness.targets.start?.options?.command).not.toContain(
      "KEYMAXXER_SIDECAR_URL",
    )
  })

  test("uses TanStack Start SPA mode without the old API proxy", async () => {
    const viteConfig = await readFile(
      new URL("../vite.config.ts", import.meta.url),
      "utf8",
    )

    expect(viteConfig).toContain("tanstackStart")
    expect(viteConfig).toContain("enabled: true")
    expect(viteConfig).not.toContain("3001")
    expect(viteConfig).not.toContain("proxy")
  })
})
