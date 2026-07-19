import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  BINARY_RELATIVE_PATH,
  selectPlatformPackage,
} from "../bin/select-platform.js"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")

const hostSelection = selectPlatformPackage({
  platform: process.platform,
  arch: process.arch,
})

const packageVersion = (
  JSON.parse(await Bun.file(join(appRoot, "package.json")).text()) as {
    version: string
  }
).version

const binaryPath = hostSelection.ok
  ? join(
      workspaceRoot,
      "packages",
      hostSelection.packageName,
      BINARY_RELATIVE_PATH,
    )
  : ""

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForHttp = async (
  url: string,
  timeoutMs: number,
): Promise<Response> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" })
      if (response.status > 0) {
        return response
      }
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(
    `Timed out waiting for ${url}: ${
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

describe("compiled host binary ambient-auth smoke", () => {
  let fixtureRoot = ""
  let runCwd = ""
  let databasePath = ""
  let restrictedBin = ""
  let port = 0

  beforeAll(async () => {
    if (!hostSelection.ok) {
      throw new Error(hostSelection.message)
    }

    const compile = Bun.spawnSync(
      ["bun", "nx", "run", "ready-for-agent:compile", "--args=--platform=host"],
      {
        cwd: workspaceRoot,
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
      },
    )
    if (compile.exitCode !== 0) {
      throw new Error("ready-for-agent:compile failed")
    }

    const binary = Bun.file(binaryPath)
    if (!(await binary.exists())) {
      throw new Error(`Compiled binary missing at ${binaryPath}`)
    }

    fixtureRoot = mkdtempSync(join(tmpdir(), "rfa-host-binary-"))
    runCwd = join(fixtureRoot, "unrelated-cwd")
    databasePath = join(fixtureRoot, "data", "ready-for-agent.db")
    restrictedBin = join(fixtureRoot, "bin")
    mkdirSync(runCwd, { recursive: true })
    mkdirSync(dirname(databasePath), { recursive: true })
    mkdirSync(restrictedBin, { recursive: true })

    // Required host tools only — no bun/nx on PATH for the product process.
    for (const tool of ["git", "gh", "opencode"] as const) {
      const resolved = Bun.which(tool)
      if (resolved === null) {
        throw new Error(`Host tool ${tool} is required for this test`)
      }
      writeFileSync(
        join(restrictedBin, tool),
        `#!/usr/bin/env bash\nexec ${JSON.stringify(resolved)} "$@"\n`,
        { mode: 0o755 },
      )
    }

    port = 18_000 + Math.floor(Math.random() * 1000)
  }, 600_000)

  afterAll(() => {
    if (fixtureRoot !== "") {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test("starts UI, assets, GraphQL, migrates, restarts, reports version, shuts down", async () => {
    const env: NodeJS.ProcessEnv = {
      HOME: process.env.HOME,
      PATH: restrictedBin,
      PORT: String(port),
      SQLITE_DATABASE_PATH: databasePath,
      KEYMAXXER_ENABLED: "false",
      NO_BROWSER: "1",
    }

    const version = Bun.spawnSync([binaryPath, "--version"], {
      cwd: runCwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(version.exitCode).toBe(0)
    const versionText = new TextDecoder().decode(version.stdout).trim()
    // Version is injected from package.json at embed/compile time (not a
    // hardcoded source constant independent of the package metadata).
    expect(versionText).toContain(packageVersion)

    const help = Bun.spawnSync([binaryPath, "--help"], {
      cwd: runCwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(help.exitCode).toBe(0)
    const helpText = new TextDecoder().decode(help.stdout)
    expect(helpText).toContain("add")
    expect(helpText).toContain("start")
    expect(helpText).not.toContain("remove-github-token")

    const startOnce = async () => {
      const child = spawn(binaryPath, ["--no-open"], {
        cwd: runCwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      })
      let stderr = ""
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk
      })
      const base = `http://127.0.0.1:${port}`
      try {
        const root = await waitForHttp(`${base}/`, 60_000)
        expect(root.status).toBe(200)
        const htmlBytes = new Uint8Array(await root.arrayBuffer())
        const html = new TextDecoder("utf-8", { fatal: false }).decode(
          htmlBytes,
        )
        expect(html.toLowerCase()).toContain("html")

        const assetMatch = html.match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/)
        expect(assetMatch).not.toBeNull()
        const assetPath = assetMatch?.[0]
        if (assetPath === undefined) {
          throw new Error("No fingerprinted asset reference in shell HTML")
        }
        const asset = await fetch(`${base}${assetPath}`)
        expect(asset.status).toBe(200)
        const assetBody = await asset.arrayBuffer()
        expect(assetBody.byteLength).toBeGreaterThan(100)

        const graphql = await fetch(`${base}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ health }" }),
        })
        expect(graphql.status).toBe(200)
        const payload = (await graphql.json()) as {
          data?: { health?: boolean }
        }
        expect(payload.data?.health).toBe(true)

        expect(stderr).not.toContain("monorepo root")
        expect(stderr).not.toContain("Could not find the ready-for-agent")
      } finally {
        await killTree(child)
        await sleep(500)
      }
    }

    await startOnce()
    // Restart against the same database — migrations must be idempotent.
    await startOnce()
  }, 180_000)
})
