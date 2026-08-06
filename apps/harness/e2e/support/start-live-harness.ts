/**
 * Start the production-built Harness with a fresh isolated database.
 * Production lifecycle owns migrations and Keymaxxer Sidecar coordination.
 *
 * CI / fixture mode: temporary HOME with the checked-in encrypted vault.
 * Local mode: developer's vault; does not copy over ~/.keymaxxer.
 *
 * The Harness runs as a supervised child so scenarios can request a restart
 * and seed legacy rows against the stopped database (issue #838); see
 * `live-harness-control.ts` for the file protocol. A deterministic fake
 * `claude` binary is prepended to `PATH` so Claude Code readiness and its
 * Agent Model catalog are fixed for the run: no Anthropic login, no AWS call,
 * and no billable model is ever involved. `CLAUDE_CODE_USE_BEDROCK` is
 * explicitly removed so the Harness runs in first-party configuration mode.
 */

import { type ChildProcess, spawn } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { E2E_HARNESS_PORT } from "./constants.ts"
import {
  CONTROL_FILES,
  LIVE_HARNESS_STATE_FILE,
  type LiveHarnessState,
} from "./live-harness-control.ts"
import { Database } from "bun:sqlite"

const supportDir = dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolve(supportDir, "../..")
const workspaceRoot = resolve(harnessRoot, "../..")
const fixtureVaultDir = resolve(workspaceRoot, "e2e/fixtures/keymaxxer")
const port = Number(process.env.E2E_HARNESS_PORT ?? E2E_HARNESS_PORT)

const runDir = mkdtempSync(join(tmpdir(), "ready-for-agent-e2e-harness-"))
const dbPath = join(runDir, "harness.db")
const controlDir = join(runDir, "control")
const binDir = join(runDir, "bin")
mkdirSync(controlDir, { recursive: true })
mkdirSync(binDir, { recursive: true })

const controlFile = (
  file: (typeof CONTROL_FILES)[keyof typeof CONTROL_FILES],
) => join(controlDir, file)

writeFileSync(controlFile(CONTROL_FILES.claudeMode), "firstParty")

/**
 * Fake `claude` CLI. Only `auth status` matters for readiness and catalog:
 * first-party authenticated yields the adapter's static alias catalog, and
 * unauthenticated yields Claude Code Unavailable with no catalog. Agent Turns
 * are never run in these scenarios, so any other invocation is a loud failure
 * rather than a silent success.
 */
writeFileSync(
  join(binDir, "claude"),
  `#!/usr/bin/env bash
set -u
if [ "\${1-}" = "--version" ]; then
  echo "0.0.0-e2e-fake (Claude Code)"
  exit 0
fi
if [ "\${1-}" = "auth" ] && [ "\${2-}" = "status" ]; then
  mode="$(cat ${JSON.stringify(controlFile(CONTROL_FILES.claudeMode))} 2>/dev/null || echo firstParty)"
  if [ "$mode" = "unauthenticated" ]; then
    echo '{"loggedIn":false,"apiProvider":"firstParty"}'
    exit 1
  fi
  echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'
  exit 0
fi
echo "e2e fake claude: unsupported invocation: $*" >&2
exit 1
`,
)
chmodSync(join(binDir, "claude"), 0o755)

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
  SQLITE_DATABASE_PATH: dbPath,
  PORT: String(port),
  NO_BROWSER: "1",
}
// First-party configuration mode: a stale Bedrock value must be visible as
// unavailable rather than accepted, and no AWS discovery may be attempted.
delete env.CLAUDE_CODE_USE_BEDROCK

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

const state: LiveHarnessState = { dbPath, controlDir }
writeFileSync(LIVE_HARNESS_STATE_FILE, JSON.stringify(state))

let generation = 0
let child: ChildProcess | null = null
let stopping = false
let restarting = false

const startChild = () => {
  generation += 1
  child = spawn(
    process.execPath,
    ["--conditions", "@ready-for-agent/source", serverEntry],
    { cwd: harnessRoot, env, stdio: "inherit" },
  )
  writeFileSync(controlFile(CONTROL_FILES.generation), String(generation))
  child.on("exit", (childCode, signal) => {
    if (stopping || restarting) {
      return
    }
    cleanup()
    if (signal) process.kill(process.pid, signal)
    process.exit(childCode ?? 1)
  })
}

const cleanup = () => {
  rmSync(runDir, { recursive: true, force: true })
  rmSync(LIVE_HARNESS_STATE_FILE, { force: true })
}

const stopChild = () =>
  new Promise<void>((done) => {
    const current = child
    if (current === null || current.exitCode !== null) {
      done()
      return
    }
    current.once("exit", () => done())
    current.kill("SIGTERM")
  })

/** Apply a scenario's seed SQL against the stopped Harness database. */
const applySeedSql = () => {
  const seedPath = controlFile(CONTROL_FILES.seedSql)
  if (!existsSync(seedPath)) {
    return
  }
  const sql = readFileSync(seedPath, "utf8")
  unlinkSync(seedPath)
  if (sql.trim().length === 0) {
    // A restart with nothing to seed (e.g. only the fake CLI changed).
    return
  }
  const db = new Database(dbPath)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

const pollRestartRequests = () => {
  const restartPath = controlFile(CONTROL_FILES.restart)
  setInterval(() => {
    if (restarting || stopping || !existsSync(restartPath)) {
      return
    }
    restarting = true
    unlinkSync(restartPath)
    void stopChild()
      .then(() => {
        applySeedSql()
        startChild()
      })
      .catch((error: unknown) => {
        console.error("live harness restart failed:", error)
        cleanup()
        process.exit(1)
      })
      .finally(() => {
        restarting = false
      })
  }, 100)
}

const shutdown = (signal: NodeJS.Signals) => {
  stopping = true
  child?.kill(signal)
  cleanup()
}
process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))

startChild()
pollRestartRequests()
