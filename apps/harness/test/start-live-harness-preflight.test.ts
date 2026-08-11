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
    // harness:test forces KEYMAXXER_ENABLED=false; clear it so this case
    // exercises the credential gate rather than vault-free soft-disable.
    for (const key of [
      "E2E_KEYMAXXER_MASTER_KEY",
      "KEYMAXXER_MASTER_KEY",
      "CI",
      "E2E_USE_FIXTURE_VAULT",
      "E2E_ALLOW_KEYMAXXER_PROMPTS",
      "KEYMAXXER_ENABLED",
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
    for (const key of [
      "E2E_KEYMAXXER_MASTER_KEY",
      "KEYMAXXER_MASTER_KEY",
      "KEYMAXXER_ENABLED",
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
    expect(result.stderr).toContain("E2E_KEYMAXXER_MASTER_KEY")
    expect(result.stderr).not.toContain("Production build missing")
  })

  test("KEYMAXXER_ENABLED=false skips credential preflight (vault-free e2e)", () => {
    const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
    // Invalid agent-backend mode fails after Keymaxxer policy, without needing
    // a missing production build (dist may already exist from a prior e2e run).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KEYMAXXER_ENABLED: "false",
      CI: "true",
      E2E_AGENT_BACKEND_MODE: "not-a-valid-mode",
    }
    for (const key of [
      "E2E_KEYMAXXER_MASTER_KEY",
      "KEYMAXXER_MASTER_KEY",
      "E2E_ALLOW_KEYMAXXER_PROMPTS",
      "E2E_USE_FIXTURE_VAULT",
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
    expect(result.stderr).not.toContain("E2E_KEYMAXXER_MASTER_KEY")
    expect(result.stderr).not.toContain("E2E_ALLOW_KEYMAXXER_PROMPTS")
    expect(result.stderr).toContain("E2E_AGENT_BACKEND_MODE")
  })
})
