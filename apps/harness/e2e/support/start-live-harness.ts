/**
 * Start the production-built Harness with a fresh isolated database and the
 * real Keymaxxer Sidecar (via run-with-keymaxxer-sidecar).
 *
 * CI / fixture mode: temporary HOME with the checked-in encrypted vault.
 * Local mode: developer's vault; does not copy over ~/.keymaxxer.
 */

import { spawn } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { E2E_HARNESS_PORT } from "./constants.ts"

const supportDir = dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolve(supportDir, "../..")
const workspaceRoot = resolve(harnessRoot, "../..")
const fixtureVaultDir = resolve(workspaceRoot, "e2e/fixtures/keymaxxer")
const port = Number(process.env.E2E_HARNESS_PORT ?? E2E_HARNESS_PORT)

const runDir = mkdtempSync(join(tmpdir(), "ready-for-agent-e2e-harness-"))
const dbPath = join(runDir, "harness.db")

const env: NodeJS.ProcessEnv = {
  ...process.env,
  SQLITE_DATABASE_PATH: dbPath,
  PORT: String(port),
}

const masterKey =
  process.env.E2E_KEYMAXXER_MASTER_KEY?.trim() ||
  process.env.KEYMAXXER_MASTER_KEY?.trim()
const useFixtureVault =
  process.env.CI === "true" ||
  process.env.E2E_USE_FIXTURE_VAULT === "1" ||
  Boolean(masterKey)

if (useFixtureVault) {
  if (!masterKey) {
    console.error(
      "CI live e2e requires E2E_KEYMAXXER_MASTER_KEY (or KEYMAXXER_MASTER_KEY).",
    )
    process.exit(1)
  }
  const keymaxxerHome = join(runDir, "keymaxxer-home")
  const keymaxxerDir = join(keymaxxerHome, ".keymaxxer")
  mkdirSync(keymaxxerDir, { recursive: true })
  copyFileSync(
    join(fixtureVaultDir, "vault.db"),
    join(keymaxxerDir, "vault.db"),
  )
  copyFileSync(
    join(fixtureVaultDir, "vault.meta.json"),
    join(keymaxxerDir, "vault.meta.json"),
  )
  env.HOME = keymaxxerHome
  env.KEYMAXXER_MASTER_KEY = masterKey
  env.KEYMAXXER_APPROVE = "deny"
  // Fresh sidecar bound to the fixture vault — do not reuse a developer sidecar.
  delete env.KEYMAXXER_SIDECAR_URL
}

const serverEntry = resolve(harnessRoot, "server.ts")
const distServer = resolve(harnessRoot, "dist/server/server.js")
if (!existsSync(distServer)) {
  console.error(
    `Production build missing at ${distServer}. Run harness:build before e2e.`,
  )
  process.exit(1)
}

const migrate = spawn(
  process.execPath,
  [
    "--conditions",
    "@ready-for-agent/source",
    resolve(workspaceRoot, "packages/db/src/bin/migrate.ts"),
  ],
  {
    cwd: workspaceRoot,
    env,
    stdio: "inherit",
  },
)

migrate.on("exit", (code) => {
  if (code !== 0) {
    rmSync(runDir, { recursive: true, force: true })
    process.exit(code ?? 1)
  }

  const child = spawn(
    process.execPath,
    [
      "--conditions",
      "@ready-for-agent/source",
      resolve(workspaceRoot, "scripts/run-with-keymaxxer-sidecar.ts"),
      process.execPath,
      "--conditions",
      "@ready-for-agent/source",
      serverEntry,
    ],
    {
      cwd: harnessRoot,
      env,
      stdio: "inherit",
    },
  )

  const shutdown = (signal: NodeJS.Signals) => {
    child.kill(signal)
    rmSync(runDir, { recursive: true, force: true })
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))

  child.on("exit", (childCode, signal) => {
    rmSync(runDir, { recursive: true, force: true })
    if (signal) process.kill(process.pid, signal)
    process.exit(childCode ?? 1)
  })
})
