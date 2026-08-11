#!/usr/bin/env bun
/**
 * Overnight published-install smoke: install `ready-for-agent` from the npm
 * registry (user path, not monorepo pack), start the harness without
 * `opencode` on PATH, and assert first-run health plus default Agent Backend
 * Unavailable reporting (issue #937).
 *
 * Complementary to `packed-install-smoke.ts` (main CI pack-from-source gate).
 * Invoked by `.github/workflows/overnight-install-smoke.yml`.
 *
 * Bun is used only to drive this test harness. The product under test is the
 * npm-global `ready-for-agent` binary with a restricted PATH (no bun/nx).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseMastheadProductVersion } from "./write-ready-for-agent-version.ts"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appRoot = join(scriptDir, "..")

const args = process.argv.slice(2)
const versionArg = (() => {
  const flag = args.find((arg) => arg.startsWith("--version="))
  if (flag !== undefined) {
    return flag.slice("--version=".length).trim() || "latest"
  }
  const idx = args.indexOf("--version")
  if (idx >= 0 && args[idx + 1] !== undefined) {
    return args[idx + 1]?.trim() || "latest"
  }
  return process.env.OVERNIGHT_INSTALL_VERSION?.trim() || "latest"
})()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const log = (message: string) => {
  process.stdout.write(`overnight-published-install-smoke: ${message}\n`)
}

const fail = (message: string): never => {
  process.stderr.write(`overnight-published-install-smoke: error: ${message}\n`)
  throw new Error(message)
}

const runChecked = (
  command: string,
  commandArgs: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    label: string
  },
) => {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? ""
    const stdout = result.stdout?.trim() ?? ""
    fail(
      `${options.label} failed (exit ${result.status ?? "?"}):\n${stdout}\n${stderr}`,
    )
  }
  return result
}

const waitForHttp = async (
  url: string,
  timeoutMs: number,
  isAlive: () => boolean,
): Promise<Response> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    if (!isAlive()) {
      fail(
        `Process exited before ${url} became ready: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      )
    }
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
  fail(
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
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await sleep(300)
      return
    }
    await sleep(50)
  }
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
  await sleep(300)
}

const listProcessGroupPids = (pgid: number): number[] => {
  const result = spawnSync("pgrep", ["-g", String(pgid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0 || result.stdout === null || result.stdout === "") {
    return []
  }
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0)
}

const listInstallPrefixPids = (installPrefix: string): number[] => {
  const result = spawnSync("ps", ["-eo", "pid=,args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0 || result.stdout === null) {
    return []
  }
  const pids: number[] = []
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    const space = trimmed.indexOf(" ")
    if (space <= 0) continue
    const pid = Number(trimmed.slice(0, space))
    const argsLine = trimmed.slice(space + 1)
    if (!Number.isFinite(pid) || pid === process.pid) continue
    if (argsLine.includes(installPrefix)) {
      pids.push(pid)
    }
  }
  return pids
}

const writeToolShim = (binDir: string, tool: string, resolved: string) => {
  symlinkSync(resolved, join(binDir, tool))
}

const diagnosticsDir =
  process.env.OVERNIGHT_INSTALL_DIAGNOSTICS_DIR?.trim() ||
  join(appRoot, "../../tmp/overnight-install-diagnostics")

let fixtureRoot = ""
let failed = false
let stdoutLog = ""
let stderrLog = ""

const preserveDiagnostics = () => {
  try {
    mkdirSync(diagnosticsDir, { recursive: true })
    writeFileSync(join(diagnosticsDir, "stdout.log"), stdoutLog)
    writeFileSync(join(diagnosticsDir, "stderr.log"), stderrLog)
    if (fixtureRoot !== "") {
      writeFileSync(
        join(diagnosticsDir, "fixture-root.txt"),
        `${fixtureRoot}\n`,
      )
    }
    log(`diagnostics written to ${diagnosticsDir}`)
  } catch (error) {
    process.stderr.write(
      `overnight-published-install-smoke: failed to write diagnostics: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
  }
}

const cleanup = () => {
  if (fixtureRoot !== "" && !failed) {
    rmSync(fixtureRoot, { recursive: true, force: true })
  } else if (fixtureRoot !== "" && failed) {
    preserveDiagnostics()
  }
}

try {
  const nodePath = Bun.which("node")
  if (nodePath === null) {
    fail("node is required on PATH to install and run the published launcher")
  }
  const npmPath = Bun.which("npm")
  if (npmPath === null) {
    fail("npm is required on PATH to install from the registry")
  }

  fixtureRoot = mkdtempSync(join(tmpdir(), "rfa-overnight-install-"))
  const installPrefix = join(fixtureRoot, "prefix")
  const runCwd = join(fixtureRoot, "unrelated-cwd")
  const databasePath = join(fixtureRoot, "data", "ready-for-agent.db")
  const restrictedBin = join(fixtureRoot, "bin")
  const logsDir = join(fixtureRoot, "logs")
  const npmCache = join(fixtureRoot, "npm-cache")
  const npmPrefix = join(fixtureRoot, "npm-global")

  mkdirSync(installPrefix, { recursive: true })
  mkdirSync(runCwd, { recursive: true })
  mkdirSync(dirname(databasePath), { recursive: true })
  mkdirSync(restrictedBin, { recursive: true })
  mkdirSync(logsDir, { recursive: true })
  mkdirSync(npmCache, { recursive: true })
  mkdirSync(npmPrefix, { recursive: true })

  // Host tools for preflight. Intentionally omit opencode so default backend
  // status is Unavailable (issue #937 overnight assertion).
  writeToolShim(restrictedBin, "node", nodePath)
  for (const tool of ["git", "gh"] as const) {
    const resolved = Bun.which(tool)
    if (resolved === null) {
      fail(`host tool ${tool} is required for this test`)
    }
    writeToolShim(restrictedBin, tool, resolved)
  }
  if (existsSync(join(restrictedBin, "opencode"))) {
    fail("overnight smoke must not place opencode on the product PATH")
  }
  if (existsSync(join(restrictedBin, "aws"))) {
    fail("overnight smoke must not place aws on the product PATH")
  }

  const packageSpec = `ready-for-agent@${versionArg}`
  log(`installing ${packageSpec} into isolated prefix ${npmPrefix}`)
  // Real user install path: npm install -g with isolated prefix/cache/HOME.
  // Product PATH later excludes bun/nx and this monorepo.
  const installEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(fixtureRoot, "home"),
    npm_config_cache: npmCache,
    npm_config_prefix: npmPrefix,
    // Avoid writing to the runner's real global prefix.
    NPM_CONFIG_PREFIX: npmPrefix,
  }
  mkdirSync(installEnv.HOME as string, { recursive: true })
  runChecked("npm", ["install", "-g", "--no-fund", "--no-audit", packageSpec], {
    cwd: fixtureRoot,
    env: installEnv,
    label: `npm install -g ${packageSpec}`,
  })

  const installedBin = join(npmPrefix, "bin", "ready-for-agent")
  const installedBinExists = spawnSync("test", ["-x", installedBin])
  if (installedBinExists.status !== 0) {
    // Windows-style layout is out of scope; on Linux npm -g puts bins under prefix/bin.
    fail(`installed ready-for-agent bin missing at ${installedBin}`)
  }

  const productEnv: NodeJS.ProcessEnv = {
    HOME: installEnv.HOME,
    PATH: restrictedBin,
    PORT: String(18_600 + Math.floor(Math.random() * 400)),
    SQLITE_DATABASE_PATH: databasePath,
    KEYMAXXER_ENABLED: "false",
    NO_BROWSER: "1",
    KEYMAXXER_ENTRYPOINT: "",
  }

  for (const forbidden of ["bun", "nx", "keymaxxer", "opencode"] as const) {
    const which = spawnSync(
      "bash",
      ["-lc", `command -v ${forbidden} || true`],
      {
        env: productEnv,
        encoding: "utf8",
      },
    )
    const found = (which.stdout ?? "").trim()
    if (found !== "") {
      fail(`product PATH must not expose ${forbidden}, found ${found}`)
    }
  }

  log("checking --version via installed command")
  const versionResult = spawnSync(installedBin, ["--version"], {
    cwd: runCwd,
    env: productEnv,
    encoding: "utf8",
  })
  stdoutLog += versionResult.stdout ?? ""
  stderrLog += versionResult.stderr ?? ""
  if (versionResult.status !== 0) {
    fail(
      `--version failed: ${versionResult.stderr ?? versionResult.stdout ?? ""}`,
    )
  }
  const versionText = (versionResult.stdout ?? "").trim()
  if (versionText.length === 0) {
    fail("--version produced empty output")
  }
  log(`version ok: ${versionText}`)

  const port = productEnv.PORT as string
  const base = `http://127.0.0.1:${port}`

  log("starting installed command (no opencode on PATH)")
  // Default command starts the harness (same as packed-install-smoke).
  const child = spawn(installedBin, ["--no-open"], {
    cwd: runCwd,
    env: productEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  let localStdout = ""
  let localStderr = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    localStdout += chunk
  })
  child.stderr?.on("data", (chunk: string) => {
    localStderr += chunk
  })

  const isAlive = () => child.exitCode === null && child.signalCode === null

  try {
    const root = await waitForHttp(`${base}/`, 120_000, isAlive)
    if (root.status !== 200) {
      fail(`GET / returned ${root.status}`)
    }
    const htmlBytes = new Uint8Array(await root.arrayBuffer())
    const html = new TextDecoder("utf-8", { fatal: false }).decode(htmlBytes)
    if (!html.toLowerCase().includes("html")) {
      fail("GET / response did not look like HTML")
    }

    // Masthead brand must show the published product version (not build placeholder).
    // Screenshot regression: published @latest rendered "RFA V0.0.0" in the header.
    // SSR may insert <!-- --> between text nodes ("RFA <!-- -->v…"); prefer the
    // title attribute which stays a single string: title="Ready for Agent v…".
    const uiVersion = parseMastheadProductVersion(html)
    if (uiVersion === undefined) {
      fail('GET / HTML missing masthead version "Ready for Agent v<semver>"')
    }
    if (uiVersion === "0.0.0") {
      fail(
        'UI masthead shows placeholder version "v0.0.0" (expected published product version)',
      )
    }
    const cliVersion =
      versionText.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? ""
    if (cliVersion !== "" && uiVersion !== cliVersion) {
      fail(
        `UI masthead version v${uiVersion} does not match CLI --version ${JSON.stringify(versionText)}`,
      )
    }
    log(`UI masthead version ok: v${uiVersion}`)

    const health = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ health }" }),
    })
    if (health.status !== 200) {
      fail(`POST /graphql health returned ${health.status}`)
    }
    const healthPayload = (await health.json()) as {
      data?: { health?: boolean }
    }
    if (healthPayload.data?.health !== true) {
      fail(
        `GraphQL health payload unexpected: ${JSON.stringify(healthPayload)}`,
      )
    }

    // Default backend must report Unavailable when opencode is absent — not a
    // crash and not a silent healthy-looking Ready default.
    const statusResponse = await fetch(`${base}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{
          agentBackendStatus {
            kind
            reason
            backend { id label }
            selectedBackend { id label }
          }
          config { selectedAgentBackend defaultModel }
        }`,
      }),
    })
    if (statusResponse.status !== 200) {
      fail(`POST /graphql agentBackendStatus returned ${statusResponse.status}`)
    }
    const statusPayload = (await statusResponse.json()) as {
      data?: {
        agentBackendStatus?: {
          kind?: string
          reason?: string | null
          backend?: { id?: string; label?: string }
          selectedBackend?: { id?: string; label?: string }
        }
        config?: {
          selectedAgentBackend?: string
          defaultModel?: string | null
        }
      }
      errors?: unknown
    }
    if (statusPayload.errors !== undefined) {
      fail(
        `agentBackendStatus GraphQL errors: ${JSON.stringify(statusPayload.errors)}`,
      )
    }
    const backendStatus = statusPayload.data?.agentBackendStatus
    if (backendStatus === undefined) {
      fail(`agentBackendStatus missing: ${JSON.stringify(statusPayload)}`)
    }
    const kind = (backendStatus.kind ?? "").toUpperCase()
    if (kind !== "UNAVAILABLE") {
      fail(
        `expected default Agent Backend UNAVAILABLE without opencode, got ${JSON.stringify(backendStatus)}`,
      )
    }
    const selectedId =
      statusPayload.data?.config?.selectedAgentBackend ??
      backendStatus.selectedBackend?.id ??
      backendStatus.backend?.id ??
      ""
    if (selectedId !== "opencode" && selectedId !== "") {
      log(
        `note: selectedAgentBackend is ${selectedId} (published package may seed differently)`,
      )
    }

    // Prefer issue #937 guidance text once published; accept legacy reason copy.
    const combined = `${localStdout}\n${localStderr}\n${backendStatus.reason ?? ""}`
    const hasUnavailableSignal =
      combined.toLowerCase().includes("not available") ||
      combined.toLowerCase().includes("unavailable") ||
      (backendStatus.reason != null && backendStatus.reason.length > 0)
    if (!hasUnavailableSignal) {
      fail(
        `expected Unavailable reason or guidance text; status=${JSON.stringify(backendStatus)} logs empty of unavailable signals`,
      )
    }

    if (
      localStderr.includes("monorepo root") ||
      localStderr.includes("Could not find the ready-for-agent")
    ) {
      fail(`startup still searches for monorepo root:\n${localStderr}`)
    }

    log("UI shell, GraphQL health, default backend Unavailable ok")
  } finally {
    stdoutLog += localStdout
    stderrLog += localStderr
    writeFileSync(join(logsDir, "start-stdout.log"), localStdout)
    writeFileSync(join(logsDir, "start-stderr.log"), localStderr)

    const childPid = child.pid
    await killTree(child)

    const groupOrphans =
      childPid === undefined ? [] : listProcessGroupPids(childPid)
    const prefixOrphans = listInstallPrefixPids(npmPrefix)
    const orphans = [...new Set([...groupOrphans, ...prefixOrphans])]
    if (orphans.length > 0) {
      const details = orphans
        .map((pid) => {
          const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
            encoding: "utf8",
          })
          return `${pid}: ${(result.stdout ?? "").trim()}`
        })
        .join("\n")
      fail(`orphaned processes after shutdown:\n${details}`)
    }
  }

  log("ok")
  process.exitCode = 0
} catch (error) {
  failed = true
  process.stderr.write(
    `overnight-published-install-smoke: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  )
  process.exitCode = 1
} finally {
  cleanup()
}
