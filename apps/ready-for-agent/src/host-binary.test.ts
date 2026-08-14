import { type ChildProcess, spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { selectPlatformPackage } from "../bin/select-platform.js"
import { Database } from "bun:sqlite"
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
      hostSelection.binaryRelativePath,
    )
  : ""

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Workspace-pinned Bun from mise.toml. Do not call `mise which`: pre-commit
 * often has an untrusted mise.toml and then falls back to a PATH canary that
 * cannot download bun-linux-x64-baseline.
 */
const workspaceBun = (): string => {
  let text = ""
  try {
    text = readFileSync(join(workspaceRoot, "mise.toml"), "utf8")
  } catch {
    return process.execPath
  }
  const version = /^bun\s*=\s*"([^"]+)"/m.exec(text)?.[1]
  if (version === undefined || version.length === 0) {
    return process.execPath
  }
  const dataDirs = [
    process.env.MISE_DATA_DIR,
    join(homedir(), ".local/share/mise"),
  ]
  for (const dataDir of dataDirs) {
    if (dataDir === undefined || dataDir.length === 0) {
      continue
    }
    const candidate = join(dataDir, "installs", "bun", version, "bin", "bun")
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return process.execPath
}

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
  let firstRunDatabasePath = ""
  let firstRunBin = ""
  let firstRunPort = 0

  beforeAll(async () => {
    if (!hostSelection.ok) {
      throw new Error(hostSelection.message)
    }

    // Call the compile script directly. Nested `bun nx run …:compile` under
    // `nx affected` (pre-commit) can race the Nx project-graph SQLite DB and
    // fail with FOREIGN KEY constraint errors even after a successful compile.
    // `ready-for-agent:test` already depends on generate-embed / graphql generate.
    const compile = Bun.spawnSync(
      [
        workspaceBun(),
        "--conditions",
        "@ready-for-agent/source",
        join(appRoot, "scripts/compile-platform-binary.ts"),
        "host",
      ],
      {
        cwd: workspaceRoot,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          NX_DAEMON: "false",
        },
      },
    )
    if (compile.exitCode !== 0) {
      throw new Error("ready-for-agent host compile failed")
    }

    const binary = Bun.file(binaryPath)
    if (!(await binary.exists())) {
      throw new Error(`Compiled binary missing at ${binaryPath}`)
    }

    fixtureRoot = mkdtempSync(join(tmpdir(), "rfa-host-binary-"))
    runCwd = join(fixtureRoot, "unrelated-cwd")
    databasePath = join(fixtureRoot, "data", "ready-for-agent.db")
    restrictedBin = join(fixtureRoot, "bin")
    firstRunDatabasePath = join(fixtureRoot, "first-run", "ready-for-agent.db")
    firstRunBin = join(fixtureRoot, "first-run-bin")
    mkdirSync(runCwd, { recursive: true })
    mkdirSync(dirname(databasePath), { recursive: true })
    mkdirSync(restrictedBin, { recursive: true })
    mkdirSync(dirname(firstRunDatabasePath), { recursive: true })
    mkdirSync(firstRunBin, { recursive: true })

    // Required host tools only — no bun/nx/aws on PATH for the product process.
    // Bedrock profile discovery is bundled via the AWS SDK (issue #822); the
    // AWS CLI must not become a packaged-binary host prerequisite.
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

    const git = Bun.which("git")
    if (git === null) {
      throw new Error("Host tool git is required for this test")
    }
    writeFileSync(
      join(firstRunBin, "git"),
      `#!/usr/bin/env bash\nexec ${JSON.stringify(git)} "$@"\n`,
      { mode: 0o755 },
    )
    // Explicitly leave `aws` off PATH even when installed on the host.
    expect(Bun.which("aws", { PATH: restrictedBin })).toBeNull()

    port = 18_000 + Math.floor(Math.random() * 1000)
    firstRunPort = port + 1_000
  }, 600_000)

  afterAll(() => {
    if (fixtureRoot !== "") {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test("bundles AWS SDK Bedrock discovery without requiring the AWS CLI (issue #822)", async () => {
    const binary = Bun.file(binaryPath)
    expect(await binary.exists()).toBe(true)
    // In-process binary scan — no host `rg`/`strings` dependency. Assert on
    // stable product strings (API name + operator warning); package path is
    // secondary evidence that the SDK client was compiled in. Latin-1 keeps a
    // 1:1 byte↔code-unit mapping so ASCII needles match embedded C strings.
    const haystack = Buffer.from(await binary.arrayBuffer()).toString("latin1")
    expect(haystack.includes("ListInferenceProfiles")).toBe(true)
    expect(
      haystack.includes("Could not list Amazon Bedrock inference profiles"),
    ).toBe(true)
    expect(haystack.includes("@aws-sdk/client-bedrock")).toBe(true)
    // No host-tool preflight string should invent an AWS CLI requirement.
    expect(haystack.includes("Install AWS CLI")).toBe(false)
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

    const startOnce = async ({
      binPath = restrictedBin,
      dbPath = databasePath,
      serverPort = port,
    }: {
      readonly binPath?: string
      readonly dbPath?: string
      readonly serverPort?: number
    } = {}) => {
      const startEnv: NodeJS.ProcessEnv = {
        ...env,
        PATH: binPath,
        PORT: String(serverPort),
        SQLITE_DATABASE_PATH: dbPath,
      }
      const child = spawn(binaryPath, ["--no-open"], {
        cwd: runCwd,
        env: startEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      })
      let stdout = ""
      let stderr = ""
      child.stdout?.setEncoding("utf8")
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk
      })
      const base = `http://127.0.0.1:${serverPort}`
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

        const jsAssetPaths = [
          ...html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.js/g),
        ].map((match) => match[0])
        expect(jsAssetPaths.length).toBeGreaterThan(0)
        const versionLabel = `v${packageVersion}`
        let uiVersionFound = false
        for (const jsPath of jsAssetPaths) {
          const jsResponse = await fetch(`${base}${jsPath}`)
          expect(jsResponse.status).toBe(200)
          const jsText = await jsResponse.text()
          if (jsText.includes(versionLabel)) {
            uiVersionFound = true
            break
          }
        }
        expect(uiVersionFound).toBe(true)

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

        const combinedOutput = `${stdout}\n${stderr}`
        expect(combinedOutput).toContain(`v${packageVersion}`)
        expect(combinedOutput).toContain(`listening on ${base}`)
        expect(stderr).not.toContain("monorepo root")
        expect(stderr).not.toContain("Could not find the ready-for-agent")
      } finally {
        await killTree(child)
        await sleep(500)
      }
    }

    // Fresh installs must reach Settings without the default OpenCode binary.
    expect(Bun.which("opencode", { PATH: firstRunBin })).toBeNull()
    await startOnce({
      binPath: firstRunBin,
      dbPath: firstRunDatabasePath,
      serverPort: firstRunPort,
    })

    // Model an existing installation whose OpenCode selection was explicitly
    // saved, then prove deleting the selected CLI still permits cold start.
    const firstRunDb = new Database(firstRunDatabasePath)
    try {
      const result = firstRunDb.run(
        `UPDATE config
         SET agent_backend_configured_at = unixepoch()
         WHERE id = 'default'`,
      )
      expect(result.changes).toBe(1)
    } finally {
      firstRunDb.close()
    }
    expect(Bun.which("opencode", { PATH: firstRunBin })).toBeNull()
    await startOnce({
      binPath: firstRunBin,
      dbPath: firstRunDatabasePath,
      serverPort: firstRunPort,
    })

    await startOnce()
    // Restart against the same database — migrations must be idempotent.
    await startOnce()
  }, 180_000)
})
