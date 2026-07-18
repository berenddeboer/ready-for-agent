/**
 * Boots the monorepo harness:dev path (Bun + vite.js, not the Node shebang),
 * asserts GraphQL `{ health }`, then terminates. Used as `harness:smoke` in CI
 * without a Keymaxxer vault.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(harnessRoot, "../..")
const sidecarWrapper = resolve(
  workspaceRoot,
  "scripts/run-with-keymaxxer-sidecar.ts",
)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForGraphqlHealth = async (
  baseUrl: string,
  timeoutMs: number,
  isAlive: () => boolean,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (!isAlive()) {
      throw new Error(
        `Dev server exited before GraphQL health succeeded: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      )
    }
    try {
      const response = await fetch(`${baseUrl}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ health }" }),
      })
      if (response.status === 200) {
        const payload = (await response.json()) as {
          data?: { health?: boolean }
        }
        if (payload.data?.health === true) {
          return
        }
        lastError = new Error(
          `Unexpected GraphQL payload: ${JSON.stringify(payload)}`,
        )
      } else {
        lastError = new Error(`HTTP ${response.status}`)
      }
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(
    `Timed out waiting for GraphQL health at ${baseUrl}/graphql: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

const killTree = async (child: ChildProcess) => {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return
    await sleep(50)
  }
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

const runDir = mkdtempSync(join(tmpdir(), "ready-for-agent-harness-smoke-"))
const dbPath = join(runDir, "harness.db")
const port = 19_000 + Math.floor(Math.random() * 1000)
const baseUrl = `http://127.0.0.1:${port}`

const env: NodeJS.ProcessEnv = {
  ...process.env,
  SQLITE_DATABASE_PATH: dbPath,
  PORT: String(port),
  KEYMAXXER_ENABLED: "false",
  NO_BROWSER: "1",
}

const migrate = spawn(
  process.execPath,
  [
    "--conditions",
    "@ready-for-agent/source",
    resolve(workspaceRoot, "packages/db/src/bin/migrate.ts"),
  ],
  {
    cwd: resolve(workspaceRoot, "packages/db"),
    env,
    stdio: "inherit",
  },
)

const migrateCode = await new Promise<number | null>((resolvePromise) => {
  migrate.on("exit", (code) => resolvePromise(code))
})
if (migrateCode !== 0) {
  rmSync(runDir, { recursive: true, force: true })
  console.error(`harness:smoke migrate failed with code ${migrateCode ?? "?"}`)
  process.exit(migrateCode ?? 1)
}

// Same boot path as harness:dev — Bun runs vite.js (not the Node shebang).
const child = spawn(
  process.execPath,
  [
    "--conditions",
    "@ready-for-agent/source",
    sidecarWrapper,
    "bash",
    "-c",
    "bun --conditions @ready-for-agent/source src/server/preflight.ts && bun --conditions @ready-for-agent/source ./node_modules/vite/bin/vite.js",
  ],
  {
    cwd: harnessRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
)

let output = ""
const append = (chunk: Buffer | string) => {
  output += typeof chunk === "string" ? chunk : chunk.toString("utf8")
}
child.stdout?.on("data", append)
child.stderr?.on("data", append)

let childExited = false
let exitCode: number | null = null
child.on("exit", (code) => {
  childExited = true
  exitCode = code
})

const cleanup = async () => {
  await killTree(child)
  rmSync(runDir, { recursive: true, force: true })
}

try {
  await waitForGraphqlHealth(baseUrl, 120_000, () => !childExited)

  const root = await fetch(`${baseUrl}/`, { redirect: "manual" })
  if (root.status <= 0) {
    throw new Error(`GET / failed with status ${root.status}`)
  }

  console.log(`harness:smoke ok (GraphQL health on ${baseUrl})`)
  await cleanup()
  process.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  if (output.trim() !== "") {
    console.error("--- dev server output ---")
    console.error(output)
  }
  if (childExited) {
    console.error(`Dev server exit code: ${exitCode ?? "?"}`)
  }
  await cleanup()
  process.exit(1)
}
