/**
 * Start the production-built Harness with a fresh isolated database.
 * When `E2E_HARNESS_WORKER_INDEX` is set (UI-history Playwright workers,
 * issue #1000), listen port, supervisor state file, database, and Keymaxxer
 * home / Sidecar are unique to that worker.
 * Production lifecycle owns migrations and Keymaxxer Sidecar coordination.
 *
 * CI / fixture mode: temporary HOME with the checked-in encrypted vault.
 * Local mode: developer's vault; does not copy over ~/.keymaxxer.
 * Vault-free mode (`KEYMAXXER_ENABLED=false`): no Keymaxxer Sidecar or vault
 * (used by `@no-backend` / `harness:e2e-no-backend`, issue #958, and by
 * `@ui-history` / `harness:e2e-ui-history`, issue #999).
 *
 * The Harness runs as a supervised child so scenarios can request a restart
 * and seed legacy rows against the stopped database (issue #838); see
 * `live-harness-control.ts` for the file protocol. A deterministic fake
 * `claude` binary is prepended to `PATH` so Claude Code readiness and its
 * Agent Model catalog are fixed for the run: no Anthropic login, no AWS call,
 * and no billable model is ever involved. `CLAUDE_CODE_USE_BEDROCK` is
 * explicitly removed so the Harness runs in first-party configuration mode.
 *
 * `E2E_AGENT_BACKEND_MODE=no-opencode` strips ambient Agent Backend CLIs
 * (`opencode`, `grok`, `codex`, ambient `claude`) from the product PATH and
 * fails closed if they still resolve, except the controlled fake `claude`
 * (issue #958).
 */

import { type ChildProcess, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  assertNoAmbientAgentCliOnProductPath,
  buildProductPath,
  resolveAgentBackendE2eMode,
} from "./agent-backend-path.ts"
import {
  type KeymaxxerE2ePolicy,
  fixtureVaultEnvOverrides,
  resolveKeymaxxerE2ePolicy,
  seedFixtureVaultHome,
} from "./keymaxxer-e2e-policy.ts"
import {
  CONTROL_FILES,
  type LiveHarnessState,
  liveHarnessStateFilePath,
} from "./live-harness-control.ts"
import { liveHarnessSupervisorBindings } from "./live-harness-worker.ts"
import { Database } from "bun:sqlite"

const supportDir = dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolve(supportDir, "../..")
const workerBindings = liveHarnessSupervisorBindings()
const port = workerBindings.port
const stateFile = liveHarnessStateFilePath(workerBindings.workerIndex)

// Fail fast, before creating any temp dir, fake CLI, or production-build
// check: a missing credential must never get far enough to touch the
// Harness, Sidecar, or Keymaxxer CLI (unless Keymaxxer is soft-disabled).
let keymaxxerPolicy: KeymaxxerE2ePolicy
let agentBackendMode: ReturnType<typeof resolveAgentBackendE2eMode>
try {
  keymaxxerPolicy = resolveKeymaxxerE2ePolicy()
  agentBackendMode = resolveAgentBackendE2eMode()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const runDir = mkdtempSync(join(tmpdir(), "ready-for-agent-e2e-harness-"))
const dbPath = join(runDir, "harness.db")
const controlDir = join(runDir, "control")
const binDir = join(runDir, "bin")
mkdirSync(controlDir, { recursive: true })
mkdirSync(binDir, { recursive: true })

/**
 * Empty OpenCode session DB so Session Telemetry can return MISSING when
 * `opencode db path` fails (CI inspect AgentBackendExitError). Absent file
 * or unresolved path is UNAVAILABLE, which is not the e2e missing-session
 * fixture outcome.
 */
const openCodeDbPath = join(runDir, "opencode.db")
{
  const openCodeDb = new Database(openCodeDbPath)
  try {
    openCodeDb.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY,
        model text,
        cost real DEFAULT 0 NOT NULL,
        tokens_input integer DEFAULT 0 NOT NULL,
        tokens_output integer DEFAULT 0 NOT NULL,
        tokens_reasoning integer DEFAULT 0 NOT NULL,
        tokens_cache_read integer DEFAULT 0 NOT NULL,
        tokens_cache_write integer DEFAULT 0 NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      )
    `)
  } finally {
    openCodeDb.close()
  }
}

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

const productPath = buildProductPath({
  mode: agentBackendMode,
  fakeCliBinDir: binDir,
  ambientPath: process.env.PATH ?? "",
})
try {
  assertNoAmbientAgentCliOnProductPath({
    mode: agentBackendMode,
    productPath,
    fakeCliBinDir: binDir,
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: productPath,
  SQLITE_DATABASE_PATH: dbPath,
  OPENCODE_DB: openCodeDbPath,
  PORT: String(port),
  NO_BROWSER: "1",
}
// First-party configuration mode: a stale Bedrock value must be visible as
// unavailable rather than accepted, and no AWS discovery may be attempted.
delete env.CLAUDE_CODE_USE_BEDROCK

if (keymaxxerPolicy.mode === "fixture") {
  const keymaxxerHome = join(runDir, "keymaxxer-home")
  seedFixtureVaultHome(keymaxxerHome)
  Object.assign(
    env,
    fixtureVaultEnvOverrides(keymaxxerHome, keymaxxerPolicy.masterKey),
  )
  // Fresh sidecar bound to the fixture vault — do not reuse a developer sidecar.
  delete env.KEYMAXXER_SIDECAR_URL
  // Ambient product soft-disable must not keep Keymaxxer off when vault e2e
  // intentionally selected fixture mode (master key wins in the policy).
  delete env.KEYMAXXER_ENABLED
} else if (keymaxxerPolicy.mode === "disabled") {
  // Soft-disable product Keymaxxer (same as overnight / packed smoke). Do not
  // seed a vault or reuse a developer sidecar.
  env.KEYMAXXER_ENABLED = "false"
  delete env.KEYMAXXER_SIDECAR_URL
  delete env.KEYMAXXER_MASTER_KEY
  delete env.E2E_KEYMAXXER_MASTER_KEY
}
// keymaxxerPolicy.mode === "interactive": leave the environment untouched so
// Keymaxxer uses the operator's ambient ~/.keymaxxer vault, prompts and all.

const serverEntry = resolve(harnessRoot, "server.ts")
const distServer = resolve(harnessRoot, "dist/server/server.js")
if (!existsSync(distServer)) {
  console.error(
    `Production build missing at ${distServer}. Run harness:build before e2e.`,
  )
  process.exit(1)
}

const state: LiveHarnessState = { dbPath, controlDir }
writeFileSync(stateFile, JSON.stringify(state))

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
  rmSync(stateFile, { force: true })
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
