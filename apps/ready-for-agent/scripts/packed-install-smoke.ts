#!/usr/bin/env bun
/**
 * Distribution-boundary acceptance test: pack the public launcher + host
 * platform package, install into an isolated prefix outside the checkout, and
 * exercise the installed `ready-for-agent` command with no monorepo / Bun / Nx
 * on the product PATH.
 *
 * Used as `ready-for-agent:packed-install-smoke` on every push to main and as a
 * release gate before npm publication.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type JsonObject,
  PLATFORM_PACKAGE_README,
  launcherManifestForNpmPublish,
} from "@ready-for-agent/release-versioning"
import {
  BINARY_RELATIVE_PATH,
  selectPlatformPackage,
} from "../bin/select-platform.js"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workspaceRoot = resolve(appRoot, "../..")

const args = new Set(process.argv.slice(2))
const skipCompile = args.has("--skip-compile")

const hostSelection = selectPlatformPackage({
  platform: process.platform,
  arch: process.arch,
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const log = (message: string) => {
  process.stdout.write(`packed-install-smoke: ${message}\n`)
}

const fail = (message: string): never => {
  process.stderr.write(`packed-install-smoke: error: ${message}\n`)
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

/** PIDs still alive in the product process group (detached spawn uses pid as pgid). */
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

/** Processes whose argv references the isolated install prefix (orphans outside the group). */
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
  // Symlink — no shell wrapper (product PATH has no bash/env).
  symlinkSync(resolved, join(binDir, tool))
}

const diagnosticsDir =
  process.env.PACKED_INSTALL_DIAGNOSTICS_DIR?.trim() ||
  join(workspaceRoot, "tmp", "packed-install-diagnostics")

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
      `packed-install-smoke: failed to write diagnostics: ${
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
  if (!hostSelection.ok) {
    fail(hostSelection.message)
  }

  const packageJsonPath = join(appRoot, "package.json")
  const packageJson = JSON.parse(
    readFileSync(packageJsonPath, "utf8"),
  ) as JsonObject
  const packageVersion = String(packageJson.version ?? "")
  if (packageVersion === "") {
    fail("launcher package.json is missing version")
  }

  const hostBinaryPath = join(
    workspaceRoot,
    "packages",
    hostSelection.packageName,
    BINARY_RELATIVE_PATH,
  )

  if (!skipCompile) {
    log("compiling host platform binary")
    const compile = spawnSync(
      "bun",
      ["nx", "run", "ready-for-agent:compile", "--args=--platform=host"],
      {
        cwd: workspaceRoot,
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
      },
    )
    if (compile.status !== 0) {
      fail("ready-for-agent:compile failed")
    }
  }

  if (!existsSync(hostBinaryPath)) {
    fail(`compiled host binary missing at ${hostBinaryPath}`)
  }
  const binaryExecutable = spawnSync("test", ["-x", hostBinaryPath])
  if (binaryExecutable.status !== 0) {
    fail(`compiled host binary is not executable at ${hostBinaryPath}`)
  }

  // All fixture roots live under the OS temp dir — never under the monorepo.
  fixtureRoot = mkdtempSync(join(tmpdir(), "rfa-packed-install-"))
  const stageRoot = join(fixtureRoot, "stage")
  const packRoot = join(fixtureRoot, "packs")
  const installPrefix = join(fixtureRoot, "prefix")
  const runCwd = join(fixtureRoot, "unrelated-cwd")
  const databasePath = join(fixtureRoot, "data", "ready-for-agent.db")
  const restrictedBin = join(fixtureRoot, "bin")
  const logsDir = join(fixtureRoot, "logs")

  mkdirSync(stageRoot, { recursive: true })
  mkdirSync(packRoot, { recursive: true })
  mkdirSync(installPrefix, { recursive: true })
  mkdirSync(runCwd, { recursive: true })
  mkdirSync(dirname(databasePath), { recursive: true })
  mkdirSync(restrictedBin, { recursive: true })
  mkdirSync(logsDir, { recursive: true })

  // Required host tools + node for the JS launcher. No bun/nx on product PATH.
  const nodePath = Bun.which("node")
  if (nodePath === null) {
    fail("node is required on PATH to run the installed launcher")
  }
  writeToolShim(restrictedBin, "node", nodePath)

  for (const tool of ["git", "gh", "opencode"] as const) {
    const resolved = Bun.which(tool)
    if (resolved === null) {
      fail(`host tool ${tool} is required for this test`)
    }
    writeToolShim(restrictedBin, tool, resolved)
  }

  // Stage platform package for npm pack (binary + publishable manifest).
  const platformStage = join(stageRoot, hostSelection.packageName)
  mkdirSync(join(platformStage, "bin"), { recursive: true })
  const platformPkgSource = JSON.parse(
    readFileSync(
      join(
        workspaceRoot,
        "packages",
        hostSelection.packageName,
        "package.json",
      ),
      "utf8",
    ),
  ) as JsonObject
  writeFileSync(
    join(platformStage, "package.json"),
    `${JSON.stringify(
      {
        ...platformPkgSource,
        version: packageVersion,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(platformStage, "README.md"), PLATFORM_PACKAGE_README)
  copyFileSync(hostBinaryPath, join(platformStage, BINARY_RELATIVE_PATH))
  spawnSync("chmod", ["+x", join(platformStage, BINARY_RELATIVE_PATH)])

  // Stage launcher package for npm pack (JS launcher only; monorepo deps stripped).
  const launcherStage = join(stageRoot, "ready-for-agent")
  mkdirSync(join(launcherStage, "bin"), { recursive: true })
  const publishManifest = launcherManifestForNpmPublish(
    packageJson,
    packageVersion,
  )
  writeFileSync(
    join(launcherStage, "package.json"),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
  )
  copyFileSync(
    join(appRoot, "bin/ready-for-agent.js"),
    join(launcherStage, "bin/ready-for-agent.js"),
  )
  copyFileSync(
    join(appRoot, "bin/select-platform.js"),
    join(launcherStage, "bin/select-platform.js"),
  )
  copyFileSync(
    join(workspaceRoot, "README.md"),
    join(launcherStage, "README.md"),
  )

  log(`packing ${hostSelection.packageName}@${packageVersion}`)
  runChecked("npm", ["pack", "--pack-destination", packRoot], {
    cwd: platformStage,
    label: "npm pack platform",
  })
  log(`packing ready-for-agent@${packageVersion}`)
  runChecked("npm", ["pack", "--pack-destination", packRoot], {
    cwd: launcherStage,
    label: "npm pack launcher",
  })

  const tarballs = readdirSync(packRoot)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(packRoot, name))
    .sort()
  if (tarballs.length < 2) {
    fail(`expected two package tarballs, found: ${tarballs.join(", ")}`)
  }

  log(`installing into isolated prefix ${installPrefix}`)
  runChecked("npm", ["init", "-y"], {
    cwd: installPrefix,
    label: "npm init install prefix",
  })
  // Install platform + launcher tarballs together so optionalDependencies resolve
  // from the local pack set rather than the public registry.
  runChecked("npm", ["install", "--no-fund", "--no-audit", ...tarballs], {
    cwd: installPrefix,
    label: "npm install packed packages",
  })

  const installedBin = join(
    installPrefix,
    "node_modules",
    ".bin",
    "ready-for-agent",
  )
  const installedBinExists = spawnSync("test", ["-x", installedBin])
  if (installedBinExists.status !== 0) {
    fail(`installed ready-for-agent bin missing at ${installedBin}`)
  }

  // Guard: install prefix and run cwd must sit outside the monorepo checkout.
  if (
    installPrefix.startsWith(workspaceRoot) ||
    runCwd.startsWith(workspaceRoot)
  ) {
    fail("install prefix / run cwd must be outside the monorepo checkout")
  }

  const productEnv: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    PATH: restrictedBin,
    PORT: String(18_500 + Math.floor(Math.random() * 500)),
    SQLITE_DATABASE_PATH: databasePath,
    KEYMAXXER_ENABLED: "false",
    NO_BROWSER: "1",
    // Ensure Keymaxxer cannot be found via ambient PATH or entrypoint.
    KEYMAXXER_ENTRYPOINT: "",
  }

  // Assert product PATH cannot resolve bun/nx/keymaxxer.
  for (const forbidden of ["bun", "nx", "keymaxxer"] as const) {
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
  if (!versionText.includes(packageVersion)) {
    fail(
      `--version output ${JSON.stringify(versionText)} does not include packed version ${packageVersion}`,
    )
  }
  log(`version ok: ${versionText}`)

  const port = productEnv.PORT as string
  const base = `http://127.0.0.1:${port}`

  const startAndExercise = async (label: string) => {
    log(`starting installed command (${label})`)
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
      const root = await waitForHttp(`${base}/`, 90_000, isAlive)
      if (root.status !== 200) {
        fail(`GET / returned ${root.status}`)
      }
      const htmlBytes = new Uint8Array(await root.arrayBuffer())
      const html = new TextDecoder("utf-8", { fatal: false }).decode(htmlBytes)
      if (!html.toLowerCase().includes("html")) {
        fail("GET / response did not look like HTML")
      }

      const assetMatch = html.match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/)
      if (assetMatch === null || assetMatch[0] === undefined) {
        fail("No fingerprinted asset reference in shell HTML")
      }
      const assetPath = assetMatch[0]
      const asset = await fetch(`${base}${assetPath}`)
      if (asset.status !== 200) {
        fail(`GET ${assetPath} returned ${asset.status}`)
      }
      const assetBody = await asset.arrayBuffer()
      if (assetBody.byteLength <= 100) {
        fail(`asset ${assetPath} was unexpectedly small`)
      }

      const graphql = await fetch(`${base}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ health }" }),
      })
      if (graphql.status !== 200) {
        fail(`POST /graphql returned ${graphql.status}`)
      }
      const payload = (await graphql.json()) as {
        data?: { health?: boolean }
      }
      if (payload.data?.health !== true) {
        fail(`GraphQL health payload unexpected: ${JSON.stringify(payload)}`)
      }

      if (
        localStderr.includes("monorepo root") ||
        localStderr.includes("Could not find the ready-for-agent")
      ) {
        fail(`startup still searches for monorepo root:\n${localStderr}`)
      }

      log(`${label}: UI, asset, GraphQL ok`)
    } finally {
      stdoutLog += localStdout
      stderrLog += localStderr
      writeFileSync(join(logsDir, `${label}-stdout.log`), localStdout)
      writeFileSync(join(logsDir, `${label}-stderr.log`), localStderr)

      const childPid = child.pid
      await killTree(child)

      // Process tree must fully exit: no Harness, Sidecar, or keyholder left.
      // Scope to this spawn's process group and the isolated install prefix so
      // unrelated developer machines (other worktrees) do not false-positive.
      const groupOrphans =
        childPid === undefined ? [] : listProcessGroupPids(childPid)
      const prefixOrphans = listInstallPrefixPids(installPrefix)
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
        fail(`orphaned processes after shutdown (${label}):\n${details}`)
      }
    }
  }

  await startAndExercise("first-start")
  // Restart against the same isolated database — migrations must be idempotent.
  await startAndExercise("restart")

  log("ok")
  process.exitCode = 0
} catch (error) {
  failed = true
  process.stderr.write(
    `packed-install-smoke: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  )
  process.exitCode = 1
} finally {
  cleanup()
}
