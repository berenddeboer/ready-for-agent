import { readFile } from "node:fs/promises"
import { createServer } from "vite"
import { describe, expect, test } from "bun:test"

type Target = {
  continuous?: boolean
  dependsOn?: unknown[]
  options?: { command?: string; env?: Record<string, string> }
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
    // Leaf must be run-dev (not bash -c): nx forwardAllArgs append onto the
    // sidecar wrapper argv, which must reach run-dev as process.argv.
    expect(harness.targets.dev?.options?.command).toMatch(
      /run-with-keymaxxer-sidecar\.ts bun --conditions @ready-for-agent\/source src\/server\/run-dev\.ts\s*$/,
    )
    expect(harness.targets.dev?.options?.command).not.toContain("bash -c")
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

  test("harness:smoke boots the Bun-vite dev path and generates GraphQL deps", async () => {
    const harness = await readJson<{ targets: Record<string, Target> }>(
      "../project.json",
    )

    expect(harness.targets.smoke?.dependsOn).toContain("db:migrate")
    expect(harness.targets.smoke?.dependsOn).toContainEqual({
      projects: ["graphql-client", "github-service", "graphql-schema"],
      target: "generate",
    })
    expect(harness.targets.smoke?.options?.command).toContain("dev-smoke.ts")
    expect(harness.targets.smoke?.options?.command).not.toContain(
      "node_modules/vite/bin/vite.js",
    )

    const smokeScript = await readFile(
      new URL("../scripts/dev-smoke.ts", import.meta.url),
      "utf8",
    )
    expect(smokeScript).toContain("KEYMAXXER_ENABLED")
    expect(smokeScript).toContain("run-with-keymaxxer-sidecar")
    expect(smokeScript).toContain(
      "bun --conditions @ready-for-agent/source ./node_modules/vite/bin/vite.js",
    )
    expect(smokeScript).toContain("{ health }")
    expect(smokeScript).toContain("AbortSignal.timeout")
    expect(smokeScript).toContain("GRAPHQL_HEALTH_TIMEOUT_MS")
    expect(smokeScript).not.toContain("E2E_KEYMAXXER_MASTER_KEY")
  })

  test("forces KEYMAXXER_ENABLED=false at the ordinary test-target boundary, but not for vault-backed live e2e", async () => {
    const harness = await readJson<{ targets: Record<string, Target> }>(
      "../project.json",
    )

    expect(harness.targets.test?.options?.env?.KEYMAXXER_ENABLED).toBe("false")
    expect(harness.targets["slow-test"]?.options?.env?.KEYMAXXER_ENABLED).toBe(
      "false",
    )
    expect(harness.targets.smoke?.options?.env?.KEYMAXXER_ENABLED).toBe("false")
    // Vault-backed live e2e intentionally keeps Keymaxxer enabled: it validates
    // the real Sidecar, CLI, and fixture credentials.
    expect(harness.targets.e2e?.options?.env?.KEYMAXXER_ENABLED).toBeUndefined()
    expect(harness.targets.e2e?.options?.command).toContain(
      "--grep-invert @no-backend",
    )
    // Live-Forge: vault-backed fixture clone path (issue #999).
    expect(
      harness.targets["e2e-live-forge"]?.options?.env?.KEYMAXXER_ENABLED,
    ).toBeUndefined()
    expect(harness.targets["e2e-live-forge"]?.options?.command).toContain(
      "--grep @live-forge",
    )
    // UI-history: vault-free persistence-seed path (issue #999).
    expect(
      harness.targets["e2e-ui-history"]?.options?.env?.KEYMAXXER_ENABLED,
    ).toBe("false")
    expect(
      harness.targets["e2e-ui-history"]?.options?.env?.E2E_KEYMAXXER_MASTER_KEY,
    ).toBe("")
    expect(
      harness.targets["e2e-ui-history"]?.options?.env?.KEYMAXXER_MASTER_KEY,
    ).toBe("")
    expect(
      harness.targets["e2e-ui-history"]?.options?.env?.E2E_AGENT_BACKEND_MODE,
    ).toBeUndefined()
    expect(harness.targets["e2e-ui-history"]?.options?.command).toContain(
      "--grep @ui-history",
    )
    // Vault-free @no-backend suite: soft-disable Keymaxxer, clear ambient
    // master keys so fixture mode cannot win, and strip OpenCode.
    expect(
      harness.targets["e2e-no-backend"]?.options?.env?.KEYMAXXER_ENABLED,
    ).toBe("false")
    expect(
      harness.targets["e2e-no-backend"]?.options?.env?.E2E_KEYMAXXER_MASTER_KEY,
    ).toBe("")
    expect(
      harness.targets["e2e-no-backend"]?.options?.env?.KEYMAXXER_MASTER_KEY,
    ).toBe("")
    expect(
      harness.targets["e2e-no-backend"]?.options?.env?.E2E_AGENT_BACKEND_MODE,
    ).toBe("no-opencode")
    expect(harness.targets["e2e-no-backend"]?.options?.command).toContain(
      "--grep @no-backend",
    )

    const runnerScript = await readFile(
      new URL("../scripts/run-unit-tests.sh", import.meta.url),
      "utf8",
    )
    expect(runnerScript).toContain("export KEYMAXXER_ENABLED=false")
  })

  test("an inherited KEYMAXXER_ENABLED=true cannot override the unit-test runner's export", async () => {
    const { spawnSync } = await import("node:child_process")
    const harnessRoot = new URL("..", import.meta.url).pathname

    // Source only the runner's own export line (not the full suite) against
    // an inherited KEYMAXXER_ENABLED=true, proving the script's real export
    // wins deterministically rather than asserting bash semantics in the
    // abstract.
    const result = spawnSync(
      "bash",
      [
        "-c",
        "source <(grep -m1 '^export KEYMAXXER_ENABLED=' scripts/run-unit-tests.sh); echo \"$KEYMAXXER_ENABLED\"",
      ],
      {
        cwd: harnessRoot,
        env: { ...process.env, KEYMAXXER_ENABLED: "true" },
        encoding: "utf8",
      },
    )

    expect(result.stdout.trim()).toBe("false")
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
