import { readFile } from "node:fs/promises"
import { createServer } from "vite"
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
  test("boots the shared Keymaxxer Sidecar via bootstrap capture for harness:dev and start", async () => {
    const harness = await readJson<{ targets: Record<string, Target> }>(
      "../project.json",
    )
    const sidecar = await readJson<{ targets: Record<string, Target> }>(
      "../../keymaxxer-sidecar/project.json",
    )

    expect(sidecar.targets.serve?.continuous).toBe(true)
    expect(harness.targets.dev?.dependsOn).not.toContainEqual({
      projects: ["keymaxxer-sidecar"],
      target: "serve",
    })
    expect(harness.targets.dev?.options?.command).toContain(
      "run-with-keymaxxer-sidecar",
    )
    expect(harness.targets.dev?.options?.command).toContain(
      "node_modules/vite/bin/vite.js",
    )
    expect(harness.targets.dev?.options?.command).toContain(
      "bun --conditions @ready-for-agent/source ./node_modules/vite/bin/vite.js",
    )
    expect(harness.targets.dev?.options?.command).toContain(
      "export SQLITE_DATABASE_PATH",
    )
    expect(harness.targets.start?.options?.command).toContain("server.ts")
    expect(harness.targets.start?.options?.command).not.toContain(
      "run-with-keymaxxer-sidecar",
    )
    expect(harness.targets.start?.dependsOn).toEqual(["build"])
    expect(harness.targets.start?.dependsOn).not.toContain("db:migrate")
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

  test("resolves workspace source exports during SSR", async () => {
    const server = await createServer({
      configFile: new URL("../vite.config.ts", import.meta.url).pathname,
      server: { middlewareMode: true },
    })

    try {
      const resolved = await server.pluginContainer.resolveId(
        "@ready-for-agent/issue-reconciler",
        new URL("../src/server/application.server.ts", import.meta.url)
          .pathname,
        { ssr: true },
      )

      expect(resolved?.id).toEndWith("/packages/issue-reconciler/src/index.ts")
    } finally {
      await server.close()
    }
  })

  test("does not load the Bun platform barrel during Node SSR", async () => {
    const applicationServer = await readFile(
      new URL("../src/server/application.server.ts", import.meta.url),
      "utf8",
    )

    expect(applicationServer).not.toContain('from "@effect/platform-bun"')
  })

  test("installs the undici stream guard only in Node development", async () => {
    const serverEntry = await readFile(
      new URL("../src/server.ts", import.meta.url),
      "utf8",
    )

    expect(serverEntry).toContain("import.meta.env.DEV")
    expect(serverEntry).toContain('typeof Bun === "undefined"')
  })

  test("does not start the long-lived worker during preflight", async () => {
    const preflight = await readFile(
      new URL("../src/server/preflight.ts", import.meta.url),
      "utf8",
    )

    expect(preflight).toContain("startWorker: false")
  })
})
