/**
 * Central non-interactive policy for live e2e's Keymaxxer usage.
 *
 * Live e2e is the one supported Harness test entry point that keeps
 * Keymaxxer enabled on purpose: it validates the production application,
 * Keymaxxer Sidecar, command-line client, and controlled Forge Repositories
 * together. That means it needs a way to run without ever prompting an
 * operator, while still allowing a human to intentionally test against their
 * own ambient vault.
 *
 * `resolveKeymaxxerE2ePolicy` is the single seam both the live-Harness
 * supervisor (`start-live-harness.ts`) and the fixture-clone helper
 * (`clone-fixture-repo.ts`) call before touching Keymaxxer, so neither can
 * drift into a silent prompt: a fixture master key selects the checked-in
 * vault, `E2E_ALLOW_KEYMAXXER_PROMPTS=1` is the only way to opt into the
 * operator's ambient vault, and anything else fails closed with an
 * actionable diagnostic.
 */

import { copyFileSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const supportDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(supportDir, "../../../..")
const fixtureVaultDir = resolve(workspaceRoot, "e2e/fixtures/keymaxxer")

export type KeymaxxerE2ePolicy =
  | { readonly mode: "fixture"; readonly masterKey: string }
  | { readonly mode: "interactive" }

const FIXTURE_REQUIRED_MESSAGE =
  "Live e2e requires E2E_KEYMAXXER_MASTER_KEY (or the legacy KEYMAXXER_MASTER_KEY) " +
  "in CI or explicit fixture-vault mode (E2E_USE_FIXTURE_VAULT=1)."

const NO_CREDENTIAL_MESSAGE = [
  "Live e2e requires a Keymaxxer credential before it can start the Harness,",
  "Sidecar, or command-line client.",
  "Set E2E_KEYMAXXER_MASTER_KEY (or the legacy KEYMAXXER_MASTER_KEY) to run",
  "non-interactively against the checked-in fixture vault, or set",
  "E2E_ALLOW_KEYMAXXER_PROMPTS=1 to explicitly opt into interactive prompts",
  "against your ambient ~/.keymaxxer vault.",
].join(" ")

/**
 * Resolves whether live e2e runs against the non-interactive fixture vault
 * or the operator's ambient vault. A fixture master key always wins. Absent
 * one, CI and explicit fixture-vault requests fail closed rather than
 * falling back to an ambient vault; local runs need the explicit
 * `E2E_ALLOW_KEYMAXXER_PROMPTS=1` opt-in to run interactively. Missing
 * credentials without that opt-in are an error, not a silent prompt.
 */
export const resolveKeymaxxerE2ePolicy = (
  environment: NodeJS.ProcessEnv = process.env,
): KeymaxxerE2ePolicy => {
  const masterKey =
    environment.E2E_KEYMAXXER_MASTER_KEY?.trim() ||
    environment.KEYMAXXER_MASTER_KEY?.trim()
  if (masterKey) {
    return { mode: "fixture", masterKey }
  }

  const fixtureRequested =
    environment.CI === "true" || environment.E2E_USE_FIXTURE_VAULT === "1"
  if (fixtureRequested) {
    throw new Error(FIXTURE_REQUIRED_MESSAGE)
  }

  if (environment.E2E_ALLOW_KEYMAXXER_PROMPTS === "1") {
    return { mode: "interactive" }
  }

  throw new Error(NO_CREDENTIAL_MESSAGE)
}

/** Seeds a fresh `HOME`-style directory with the checked-in fixture vault. */
export const seedFixtureVaultHome = (homeDir: string): void => {
  const keymaxxerDir = join(homeDir, ".keymaxxer")
  mkdirSync(keymaxxerDir, { recursive: true })
  copyFileSync(
    join(fixtureVaultDir, "vault.db"),
    join(keymaxxerDir, "vault.db"),
  )
  copyFileSync(
    join(fixtureVaultDir, "vault.meta.json"),
    join(keymaxxerDir, "vault.meta.json"),
  )
}

/** Environment overrides that point Keymaxxer at a seeded fixture vault home. */
export const fixtureVaultEnvOverrides = (
  homeDir: string,
  masterKey: string,
): NodeJS.ProcessEnv => ({
  HOME: homeDir,
  KEYMAXXER_MASTER_KEY: masterKey,
  KEYMAXXER_APPROVE: "deny",
})
