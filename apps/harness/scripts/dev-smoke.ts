/**
 * Boots the monorepo harness:dev path (Bun + vite.js, not the Node shebang),
 * asserts GraphQL `{ health }`, then loads the page in Chromium. Used as
 * `harness:smoke` in CI without a Keymaxxer vault.
 *
 * Live e2e loads a production build, which tree-shakes unused re-exports.
 * The dev server evaluates them, so a Node builtin in that graph crashes
 * the browser only here.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type Page, chromium } from "@playwright/test"
import {
  VITE_LISTENING_MARKER,
  waitForGraphqlHealth,
} from "./dev-smoke-health.ts"
import { smokeProcessSnapshot } from "./smoke-diagnostics.ts"

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(harnessRoot, "../..")
const sidecarWrapper = resolve(
  workspaceRoot,
  "scripts/run-with-keymaxxer-sidecar.ts",
)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Overall wait for cold CI Vite first boot (empty dep graph, no Nx cache). */
const GRAPHQL_HEALTH_TIMEOUT_MS = 360_000

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
  HARNESS_STARTUP_DIAGNOSTICS: "1",
}

console.log("[harness:smoke] migrating isolated database")
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
console.log("[harness:smoke] migration complete; launching preflight then Vite")
const child = spawn(
  process.execPath,
  [
    "--conditions",
    "@ready-for-agent/source",
    sidecarWrapper,
    "bash",
    "-c",
    "bun --conditions @ready-for-agent/source src/server/preflight.ts && printf '[harness:smoke] preflight exited; launching Vite\\n' && bun --conditions @ready-for-agent/source ./node_modules/vite/bin/vite.js",
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

/**
 * SSR already includes the Jobs shell. The client entry is an async module,
 * so DOMContentLoaded fires before that graph runs. Success is TanStack
 * hydration after that entry loads (`$_TSR` is deleted only once both the
 * stream and hydration have finished). A Vite overlay or page error fails
 * the wait instead of waiting out a cold compile.
 */
const CLIENT_SETTLED = `(() => {
  if (document.querySelector("vite-error-overlay") != null) return "overlay"
  const started = performance.getEntriesByType("resource").some((entry) =>
    entry.name.includes("tanstack-start-dev-client-entry")
  )
  if (!started) return undefined
  const bootstrap = window.$_TSR
  if (bootstrap == null || bootstrap.hydrated === true) return "ready"
  return undefined
})()`

const pageErrorsOf = (page: Page): string[] => {
  const errors: string[] = []
  page.on("pageerror", (error) => {
    errors.push(error.stack ?? error.message)
  })
  return errors
}

const clientStatus = (value: unknown): "ready" | "overlay" => {
  if (value === "ready" || value === "overlay") return value
  throw new Error(`Dev client returned an unexpected status: ${String(value)}`)
}

const assertDevPageLoads = async (baseUrl: string): Promise<void> => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const pageErrors = pageErrorsOf(page)
    page.setDefaultNavigationTimeout(60_000)
    await page.goto(`${baseUrl}/?theme=light`, {
      waitUntil: "domcontentloaded",
    })
    if (pageErrors.length > 0) {
      throw new Error(
        `Dev page threw in the browser:\n${pageErrors.join("\n\n")}`,
      )
    }
    const settled = page.waitForFunction(CLIENT_SETTLED, undefined, {
      timeout: GRAPHQL_HEALTH_TIMEOUT_MS,
    })
    void settled.catch(() => undefined)
    const crashed = new Promise<string>((resolve) => {
      page.on("pageerror", (error) => {
        resolve(error.stack ?? error.message)
      })
    })
    const outcome = await Promise.race([
      settled.then(async (handle) => ({
        kind: "settled" as const,
        status: clientStatus(await handle.jsonValue()),
      })),
      crashed.then((message) => ({ kind: "pageerror" as const, message })),
    ])
    if (outcome.kind === "pageerror") {
      throw new Error(`Dev page threw in the browser:\n${outcome.message}`)
    }
    if (outcome.status === "overlay") {
      const text = await page.locator("vite-error-overlay").first().innerText()
      throw new Error(`Dev page threw in the browser:\n${text}`)
    }
    if (pageErrors.length > 0) {
      throw new Error(
        `Dev page threw in the browser:\n${pageErrors.join("\n\n")}`,
      )
    }
    await page.getByRole("navigation", { name: "Primary" }).waitFor({
      state: "visible",
    })
  } finally {
    await browser.close()
  }
}

const cleanup = async () => {
  await killTree(child)
  rmSync(runDir, { recursive: true, force: true })
}

try {
  console.log(
    `[harness:smoke] waiting for GraphQL health (processGroup=${child.pid ?? "?"}, timeoutMs=${GRAPHQL_HEALTH_TIMEOUT_MS})`,
  )
  await waitForGraphqlHealth(
    baseUrl,
    GRAPHQL_HEALTH_TIMEOUT_MS,
    () => !childExited,
    () => output.includes(VITE_LISTENING_MARKER),
  )

  console.log("[harness:smoke] GraphQL healthy; requesting GET /")
  const root = await fetch(`${baseUrl}/`, { redirect: "manual" })
  if (root.status <= 0) {
    throw new Error(`GET / failed with status ${root.status}`)
  }

  console.log("[harness:smoke] loading the dev page in Chromium")
  await assertDevPageLoads(baseUrl)

  console.log(`harness:smoke ok (dev page loaded on ${baseUrl})`)
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
  if (child.pid !== undefined) {
    console.error("--- smoke process snapshot ---")
    console.error(smokeProcessSnapshot(child.pid))
  }
  await cleanup()
  process.exit(1)
}
