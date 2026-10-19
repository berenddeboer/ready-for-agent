/**
 * Fresh-browser proof that Open in OpenCode lands on the requested Session.
 *
 * Isolated OpenCode servers only (`serve`, private XDG dirs). The production
 * Harness is a child process with its own database. Nothing here writes the
 * operator's service registration, configuration, or live Work Items.
 */
import { type ChildProcess, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { chromium } from "@playwright/test"
import {
  mintOpenCodeSessionHandoff,
  openCodeBasicAuthHeaders,
  selectOpenCodeHandoffServer,
} from "@ready-for-agent/opencode"
import { Database } from "bun:sqlite"

const harnessRoot = resolve(import.meta.dir, "..")
const distServer = resolve(harnessRoot, "dist/server/server.js")

if (!existsSync(distServer)) {
  console.error(
    `Production build missing at ${distServer}. Run harness:build before this test.`,
  )
  process.exit(1)
}

const passwordFor = () => `handoff-${crypto.randomUUID()}`

const reservePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("could not reserve a port"))
        return
      }
      const { port } = address
      server.close(() => resolvePort(port))
    })
  })

type IsolatedServer = {
  readonly baseUrl: string
  readonly password: string
  readonly stop: () => Promise<void>
}

const startOpenCode = async (label: string): Promise<IsolatedServer> => {
  const root = mkdtempSync(join(tmpdir(), `rfa-handoff-${label}-`))
  const port = await reservePort()
  const password = passwordFor()
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_SERVER_PASSWORD: password,
  }
  for (const dir of [
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    join(root, "proj"),
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  const proc = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: join(root, "proj"),
      env,
      stdio: "ignore",
    },
  )
  const baseUrl = `http://127.0.0.1:${String(port)}`
  const headers = openCodeBasicAuthHeaders(password)
  const deadline = Date.now() + 20_000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/info`, { headers })
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      // starting
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  if (!ready) {
    proc.kill()
    throw new Error(`${label} OpenCode server did not become ready`)
  }
  return {
    baseUrl,
    password,
    stop: async () => {
      proc.kill()
      await new Promise((resolveWait) =>
        proc.once("exit", () => resolveWait(undefined)),
      )
    },
  }
}

const createSession = async (
  server: IsolatedServer,
  title: string,
): Promise<string> => {
  const response = await fetch(`${server.baseUrl}/api/session`, {
    method: "POST",
    headers: {
      ...openCodeBasicAuthHeaders(server.password),
      "content-type": "application/json",
    },
    body: JSON.stringify({ title }),
  })
  if (!response.ok) {
    throw new Error(`create session failed ${response.status}`)
  }
  const body = (await response.json()) as { data?: { id?: string } }
  const id = body.data?.id
  if (id === undefined || !id.startsWith("ses_")) {
    throw new Error("isolated server did not return a session id")
  }
  return id
}

const redeemInFreshBrowser = async (input: {
  readonly connectUrl: string
  readonly sessionUrl: string
  readonly sessionId: string
  readonly title: string
  readonly targetOrigin: string
}): Promise<void> => {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.setContent("<button id='go'>go</button>")
    const popupPromise = page.waitForEvent("popup")
    await page.evaluate((launch) => {
      const opened = window.open("about:blank", "_blank")
      if (opened === null) throw new Error("popup blocked")
      opened.location.href = launch.connectUrl
      const started = Date.now()
      const timer = window.setInterval(() => {
        let crossOrigin = false
        try {
          void opened.location.href
        } catch {
          crossOrigin = true
        }
        if (crossOrigin && Date.now() - started > 200) {
          window.clearInterval(timer)
          opened.location.href = launch.sessionUrl
        }
      }, 30)
    }, input)
    const popup = await popupPromise
    await popup.waitForURL(/\/session\//, { timeout: 15_000 })
    await popup.waitForTimeout(1_200)
    const text = await popup.evaluate(() => document.body.innerText)
    const url = popup.url()
    if (
      text.includes("Connect to a server") ||
      text.includes("Paste the pairing")
    ) {
      throw new Error(
        `fresh browser landed on the connect screen: ${text.slice(0, 300)}`,
      )
    }
    if (!text.includes(input.title) && !text.includes(input.sessionId)) {
      throw new Error(
        `fresh browser did not show the session: ${text.slice(0, 300)}`,
      )
    }
    if (!url.startsWith(input.targetOrigin)) {
      throw new Error(
        `fresh browser opened ${url}, expected ${input.targetOrigin}`,
      )
    }
  } finally {
    await browser.close()
  }
}

const assertMode = async (input: {
  readonly mode: "owned" | "explicit" | "shared"
  readonly target: IsolatedServer
  readonly decoy: IsolatedServer
  readonly sessionId: string
}): Promise<void> => {
  const headers = openCodeBasicAuthHeaders(input.target.password)
  const selected = selectOpenCodeHandoffServer({
    connection:
      input.mode === "owned"
        ? {
            kind: "dedicated",
            baseUrl: input.target.baseUrl,
            headers,
          }
        : input.mode === "explicit"
          ? {
              kind: "explicit",
              baseUrl: input.target.baseUrl,
              headers,
            }
          : { kind: "default" },
    discovered:
      input.mode === "shared"
        ? { baseUrl: input.target.baseUrl, headers }
        : {
            baseUrl: input.decoy.baseUrl,
            headers: openCodeBasicAuthHeaders(input.decoy.password),
          },
  })
  const handoff = await mintOpenCodeSessionHandoff({
    server: selected,
    sessionId: input.sessionId,
  })
  if (handoff.kind !== "ready") {
    throw new Error(`${input.mode} handoff unavailable: ${handoff.message}`)
  }
  if (!handoff.launch.connectUrl.startsWith(input.target.baseUrl)) {
    throw new Error(`${input.mode} connect URL pointed at the wrong server`)
  }
  if (handoff.launch.connectUrl.includes(input.target.password)) {
    throw new Error(`${input.mode} connect URL contained the server password`)
  }
  await redeemInFreshBrowser({
    ...handoff.launch,
    sessionId: input.sessionId,
    title: "handoff fixture",
    targetOrigin: input.target.baseUrl,
  })
}

const WORK_ITEM_ID = "wi-01KZD5HAND0FF0000000000001"
const REPOSITORY_ID = "repo-01KZD5HAND0FF000000000001"
const ISSUE_ID = "issue-01KZD5HAND0FF00000000001"

const seedWorkItem = (dbPath: string, sessionId: string): void => {
  const db = new Database(dbPath)
  const now = Date.now()
  db.exec(`
    INSERT OR IGNORE INTO config (
      id, selected_agent_backend, default_model, default_thinking_level,
      review_model, review_thinking_level, backend_model_prefs,
      max_concurrent_agent_turns, max_concurrent_work_items,
      created_at, updated_at
    ) VALUES (
      'default', 'opencode', 'test-model-a', NULL, NULL, NULL, '{}', 2, 5, ${now}, ${now}
    );
    UPDATE config SET default_model = 'test-model-a' WHERE id = 'default';
    INSERT INTO repository (
      id, forge, forge_host, project_path, local_path, is_bare, paused,
      issues_reconciled_at, created_at, updated_at
    ) VALUES (
      '${REPOSITORY_ID}', 'github', 'github.com', 'e2e/opencode-handoff',
      '/tmp/${REPOSITORY_ID}', 0, 1, ${now}, ${now}, ${now}
    );
    INSERT INTO issue (
      id, repository_id, issue_number, issue_tracker, issue_native_id,
      issue_display_id, title, body, url, state,
      github_created_at, has_children, created_at, updated_at
    ) VALUES (
      '${ISSUE_ID}', '${REPOSITORY_ID}', 901, 'github', '901', '901',
      'OpenCode handoff fixture', '', 'https://example.invalid/issues/901',
      'OPEN', ${now}, 0, ${now}, ${now}
    );
    INSERT INTO work_item (
      id, repository_id, issue_number, issue_tracker, issue_native_id,
      issue_display_id, issue_url, issue_title, agent_backend,
      state, state_ready_at, paused, holds_worker_slot, session_id,
      created_at, updated_at
    ) VALUES (
      '${WORK_ITEM_ID}', '${REPOSITORY_ID}', 901, 'github', '901', '901',
      'https://example.invalid/issues/901', 'OpenCode handoff fixture', 'opencode',
      'implement', ${now}, 0, 0, '${sessionId}', ${now}, ${now}
    );
  `)
  db.close()
}

const waitForHealth = async (url: string): Promise<void> => {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "query { health }" }),
      })
      if (response.ok) {
        const body = (await response.json()) as { data?: { health?: boolean } }
        if (body.data?.health === true) return
      }
    } catch {
      // starting
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error("production Harness did not become ready")
}

const run = async (): Promise<void> => {
  const target = await startOpenCode("target")
  const decoy = await startOpenCode("decoy")
  const sessionId = await createSession(target, "handoff fixture")
  await createSession(decoy, "decoy session")
  let harness: ChildProcess | undefined
  try {
    for (const mode of ["owned", "explicit", "shared"] as const) {
      await assertMode({ mode, target, decoy, sessionId })
    }

    const runDir = mkdtempSync(join(tmpdir(), "rfa-handoff-harness-"))
    const dbPath = join(runDir, "harness.db")
    const binDir = join(runDir, "bin")
    const stateDir = join(runDir, "state")
    mkdirSync(binDir)
    mkdirSync(stateDir, { recursive: true })
    mkdirSync(join(runDir, "home"), { recursive: true })
    writeFileSync(
      join(binDir, "opencode"),
      `#!/usr/bin/env bash
set -u
if [ "\${1-}" = "--version" ]; then
  echo "opencode v2.0.32"
  exit 0
fi
if [ "\${1-}" = "service" ]; then
  echo "http://127.0.0.1:9"
  exit 0
fi
echo "[]"
exit 0
`,
    )
    chmodSync(join(binDir, "opencode"), 0o755)
    const port = await reservePort()
    const harnessUrl = `http://127.0.0.1:${String(port)}`
    harness = spawn(
      process.execPath,
      [
        "--conditions",
        "@ready-for-agent/source",
        resolve(harnessRoot, "server.ts"),
      ],
      {
        cwd: harnessRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          KEYMAXXER_ENABLED: "false",
          KEYMAXXER_SIDECAR_URL: "",
          SQLITE_DATABASE_PATH: dbPath,
          PORT: String(port),
          NO_BROWSER: "1",
          HOME: join(runDir, "home"),
          XDG_STATE_HOME: stateDir,
          READY_FOR_AGENT_OPENCODE_SERVER: target.baseUrl,
          OPENCODE_PASSWORD: target.password,
        },
        stdio: "ignore",
      },
    )
    await waitForHealth(`${harnessUrl}/graphql`)
    seedWorkItem(dbPath, sessionId)

    const browser = await chromium.launch({ headless: true })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.goto(`${harnessUrl}/`)
      await page.waitForLoadState("domcontentloaded")
      const homeText = await page.locator("body").innerText()
      if (homeText.includes("Open in OpenCode")) {
        throw new Error("main page still shows Open in OpenCode")
      }
      await page.goto(`${harnessUrl}/session/${WORK_ITEM_ID}/telemetry`)
      const launch = page.getByRole("button", { name: "Open in OpenCode" })
      await launch.waitFor({ timeout: 20_000 })
      const popupPromise = page.waitForEvent("popup")
      await launch.click()
      const popup = await popupPromise
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && !popup.url().includes("/session/")) {
        await popup.waitForTimeout(200)
      }
      const text = await popup.locator("body").innerText()
      const url = popup.url()
      if (
        text.includes("Connect to a server") ||
        text.includes("Paste the pairing")
      ) {
        throw new Error(
          `production launch landed on the connect screen: ${text.slice(0, 400)}`,
        )
      }
      if (!text.includes("handoff fixture") && !text.includes(sessionId)) {
        throw new Error(
          `production launch did not show the session: ${text.slice(0, 400)}`,
        )
      }
      if (!url.startsWith(target.baseUrl)) {
        throw new Error(
          `production launch opened ${url}, not ${target.baseUrl}`,
        )
      }
      if (url.includes(new URL(decoy.baseUrl).port)) {
        throw new Error("production launch opened the decoy server")
      }
    } finally {
      await browser.close()
    }
    console.log("opencode session handoff browser proof passed")
  } finally {
    harness?.kill()
    await target.stop()
    await decoy.stop()
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
})
