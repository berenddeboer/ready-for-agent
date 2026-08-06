import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

/**
 * Process-level regression for the live e2e Keymaxxer policy (issue #844):
 * without a fixture master key or the explicit interactive opt-in, the
 * live-Harness supervisor must exit before it creates a temp run dir, writes
 * the fake `claude` CLI, checks for a production build, or touches Keymaxxer
 * — so this never needs `harness:build` and stays fast.
 */
describe("start-live-harness preflight", () => {
  test("fails fast with an actionable diagnostic when no credential or opt-in is present", () => {
    const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
    const env = { ...process.env }
    for (const key of [
      "E2E_KEYMAXXER_MASTER_KEY",
      "KEYMAXXER_MASTER_KEY",
      "CI",
      "E2E_USE_FIXTURE_VAULT",
      "E2E_ALLOW_KEYMAXXER_PROMPTS",
    ]) {
      delete env[key]
    }

    const result = spawnSync(
      process.execPath,
      [
        "--conditions",
        "@ready-for-agent/source",
        "e2e/support/start-live-harness.ts",
      ],
      { cwd: harnessRoot, env, encoding: "utf8", timeout: 15_000 },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("E2E_ALLOW_KEYMAXXER_PROMPTS")
    expect(result.stderr).toContain("E2E_KEYMAXXER_MASTER_KEY")
    // Never got far enough to check for a production build.
    expect(result.stderr).not.toContain("Production build missing")
  })

  test("fails fast in CI mode without a master key even with the interactive opt-in", () => {
    const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "true",
      E2E_ALLOW_KEYMAXXER_PROMPTS: "1",
    }
    for (const key of ["E2E_KEYMAXXER_MASTER_KEY", "KEYMAXXER_MASTER_KEY"]) {
      delete env[key]
    }

    const result = spawnSync(
      process.execPath,
      [
        "--conditions",
        "@ready-for-agent/source",
        "e2e/support/start-live-harness.ts",
      ],
      { cwd: harnessRoot, env, encoding: "utf8", timeout: 15_000 },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("E2E_KEYMAXXER_MASTER_KEY")
    expect(result.stderr).not.toContain("Production build missing")
  })
})
