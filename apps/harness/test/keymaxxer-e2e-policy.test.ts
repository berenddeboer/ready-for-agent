import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fixtureVaultEnvOverrides,
  resolveKeymaxxerE2ePolicy,
  seedFixtureVaultHome,
} from "../e2e/support/keymaxxer-e2e-policy.ts"
import { afterEach, describe, expect, test } from "bun:test"

describe("resolveKeymaxxerE2ePolicy", () => {
  test("selects fixture mode when E2E_KEYMAXXER_MASTER_KEY is set", () => {
    const policy = resolveKeymaxxerE2ePolicy({ E2E_KEYMAXXER_MASTER_KEY: "k" })
    expect(policy).toEqual({ mode: "fixture", masterKey: "k" })
  })

  test("falls back to the legacy KEYMAXXER_MASTER_KEY", () => {
    const policy = resolveKeymaxxerE2ePolicy({ KEYMAXXER_MASTER_KEY: "legacy" })
    expect(policy).toEqual({ mode: "fixture", masterKey: "legacy" })
  })

  test("prefers E2E_KEYMAXXER_MASTER_KEY over the legacy fallback", () => {
    const policy = resolveKeymaxxerE2ePolicy({
      E2E_KEYMAXXER_MASTER_KEY: "preferred",
      KEYMAXXER_MASTER_KEY: "legacy",
    })
    expect(policy).toEqual({ mode: "fixture", masterKey: "preferred" })
  })

  test("trims whitespace and treats a blank master key as absent", () => {
    expect(() =>
      resolveKeymaxxerE2ePolicy({ E2E_KEYMAXXER_MASTER_KEY: "   " }),
    ).toThrow()
    const policy = resolveKeymaxxerE2ePolicy({
      E2E_KEYMAXXER_MASTER_KEY: "  padded  ",
    })
    expect(policy).toEqual({ mode: "fixture", masterKey: "padded" })
  })

  test("explicit interactive opt-in is honored when no credential is present", () => {
    const policy = resolveKeymaxxerE2ePolicy({
      E2E_ALLOW_KEYMAXXER_PROMPTS: "1",
    })
    expect(policy).toEqual({ mode: "interactive" })
  })

  test("rejects by default when no credential and no opt-in are present", () => {
    expect(() => resolveKeymaxxerE2ePolicy({})).toThrow(
      /E2E_ALLOW_KEYMAXXER_PROMPTS/,
    )
  })

  test("fails closed in CI even with the interactive opt-in set", () => {
    expect(() =>
      resolveKeymaxxerE2ePolicy({
        CI: "true",
        E2E_ALLOW_KEYMAXXER_PROMPTS: "1",
      }),
    ).toThrow(/E2E_KEYMAXXER_MASTER_KEY/)
  })

  test("fails closed for explicit fixture-vault mode without a master key", () => {
    expect(() =>
      resolveKeymaxxerE2ePolicy({ E2E_USE_FIXTURE_VAULT: "1" }),
    ).toThrow(/E2E_KEYMAXXER_MASTER_KEY/)
  })

  test("a master key wins over CI/fixture-vault fail-closed checks", () => {
    const policy = resolveKeymaxxerE2ePolicy({
      CI: "true",
      E2E_KEYMAXXER_MASTER_KEY: "ci-key",
    })
    expect(policy).toEqual({ mode: "fixture", masterKey: "ci-key" })
  })
})

describe("fixture vault home helpers", () => {
  let home: string | undefined

  afterEach(() => {
    if (home) {
      rmSync(home, { recursive: true, force: true })
      home = undefined
    }
  })

  test("seedFixtureVaultHome copies the checked-in vault into .keymaxxer", () => {
    home = mkdtempSync(join(tmpdir(), "keymaxxer-e2e-policy-test-"))
    seedFixtureVaultHome(home)

    expect(existsSync(join(home, ".keymaxxer", "vault.db"))).toBe(true)
    expect(existsSync(join(home, ".keymaxxer", "vault.meta.json"))).toBe(true)
    expect(() =>
      JSON.parse(
        readFileSync(join(home!, ".keymaxxer", "vault.meta.json"), "utf8"),
      ),
    ).not.toThrow()
  })

  test("fixtureVaultEnvOverrides sets HOME, master key, and deny-approve", () => {
    const overrides = fixtureVaultEnvOverrides("/tmp/fake-home", "secret-key")
    expect(overrides).toEqual({
      HOME: "/tmp/fake-home",
      KEYMAXXER_MASTER_KEY: "secret-key",
      KEYMAXXER_APPROVE: "deny",
    })
  })
})
