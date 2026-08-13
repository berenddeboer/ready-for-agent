/**
 * Central non-interactive policy for live e2e's Keymaxxer usage.
 *
 * Vault-backed live e2e (`harness:e2e` / `harness:e2e-live-forge`) keeps
 * Keymaxxer enabled on purpose: it validates the production application,
 * Keymaxxer Sidecar, command-line client, and controlled Forge Repositories
 * together. Vault-free live e2e (`harness:e2e-no-backend` and
 * `harness:e2e-ui-history`) soft-disables Keymaxxer via
 * `KEYMAXXER_ENABLED=false` (and clears fixture master-key env) so fork PRs
 * still get coverage.
 *
 * `resolveKeymaxxerE2ePolicy` is the single seam both the live-Harness
 * supervisor (`start-live-harness.ts`) and the fixture-clone helper
 * (`clone-fixture-repo.ts`) call before touching Keymaxxer, so neither can
 * drift into a silent prompt: a fixture master key selects the checked-in
 * vault, `KEYMAXXER_ENABLED=false` without a master key is vault-free
 * soft-disable, `E2E_ALLOW_KEYMAXXER_PROMPTS=1` is the only way to opt into
 * the operator's ambient vault, and anything else fails closed with an
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
  /** Soft-disabled product path (e.g. `@no-backend` e2e / KEYMAXXER_ENABLED=false). */
  | { readonly mode: "disabled" }

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
  "Vault-free suites set KEYMAXXER_ENABLED=false (e.g. harness:e2e-no-backend, harness:e2e-ui-history).",
].join(" ")

/**
 * Resolves whether live e2e runs against the non-interactive fixture vault,
 * the operator's ambient vault, or with Keymaxxer soft-disabled.
 *
 * Priority:
 * 1. A non-empty fixture master key always selects fixture mode — including
 *    when ambient `KEYMAXXER_ENABLED=false` is set from product soft-disable
 *    docs — so vault-backed `harness:e2e` is not broken by that flag.
 * 2. `KEYMAXXER_ENABLED=false` without a master key is vault-free soft-disable
 *    (`harness:e2e-no-backend` clears master-key env and sets this flag).
 * 3. CI / `E2E_USE_FIXTURE_VAULT=1` without a master key fail closed.
 * 4. `E2E_ALLOW_KEYMAXXER_PROMPTS=1` opts into ambient interactive vault.
 * 5. Otherwise fail closed with an actionable diagnostic (never silent prompt).
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

  if (environment.KEYMAXXER_ENABLED?.trim().toLowerCase() === "false") {
    return { mode: "disabled" }
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
