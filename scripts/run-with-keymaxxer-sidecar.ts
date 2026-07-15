/**
 * Spawns the Keymaxxer Sidecar, captures its stdout bootstrap capability URL,
 * then runs the given command with KEYMAXXER_SIDECAR_URL in the environment.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const KEYMAXXER_SIDECAR_URL_PREFIX = "KEYMAXXER_SIDECAR_URL="
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url))
const sidecarEntry = fileURLToPath(
  new URL("../apps/keymaxxer-sidecar/src/main.ts", import.meta.url),
)

const [command, ...commandArgs] = process.argv.slice(2)
if (command === undefined) {
  console.error("Usage: run-with-keymaxxer-sidecar.ts <command> [args...]")
  process.exit(2)
}

const existingUrl = process.env.KEYMAXXER_SIDECAR_URL?.trim()
if (existingUrl) {
  const child = spawn(command, commandArgs, {
    cwd: process.env.RUN_CWD ?? process.cwd(),
    env: process.env,
    stdio: "inherit",
  })
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    process.exit(code ?? 1)
  })
} else {
  const sidecar = spawn(
    process.execPath,
    ["--conditions", "@ready-for-agent/source", sidecarEntry],
    {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"],
    },
  )

  let settled = false
  let wrappedChild: ChildProcess | null = null
  let wrappedChildExited = false
  let sidecarExitedUnexpectedly = false
  const fail = (message: string) => {
    if (settled) return
    settled = true
    console.error(message)
    sidecar.kill("SIGTERM")
    process.exit(1)
  }

  const timeout = setTimeout(() => {
    fail("Timed out waiting for Keymaxxer Sidecar bootstrap URL")
  }, 15_000)

  if (sidecar.stdout === null) {
    fail("Keymaxxer Sidecar stdout was not captured")
    throw new Error("unreachable")
  }
  const lines = createInterface({ input: sidecar.stdout })
  lines.on("line", (line) => {
    if (!line.startsWith(KEYMAXXER_SIDECAR_URL_PREFIX)) return
    if (settled) return
    settled = true
    clearTimeout(timeout)
    lines.close()

    const url = line.slice(KEYMAXXER_SIDECAR_URL_PREFIX.length).trim()
    const child = spawn(command, commandArgs, {
      cwd: process.env.RUN_CWD ?? process.cwd(),
      env: { ...process.env, KEYMAXXER_SIDECAR_URL: url },
      stdio: "inherit",
    })
    wrappedChild = child

    const shutdown = (signal: NodeJS.Signals) => {
      child.kill(signal)
      sidecar.kill(signal)
    }
    process.once("SIGINT", () => shutdown("SIGINT"))
    process.once("SIGTERM", () => shutdown("SIGTERM"))

    child.on("exit", (code, signal) => {
      wrappedChildExited = true
      sidecar.kill("SIGTERM")
      if (sidecarExitedUnexpectedly) process.exit(1)
      if (signal) process.kill(process.pid, signal)
      process.exit(code ?? 1)
    })
  })

  sidecar.on("exit", (code) => {
    if (!settled) {
      fail(`Keymaxxer Sidecar exited before bootstrap (code ${code ?? "?"})`)
      return
    }
    if (!wrappedChildExited) {
      sidecarExitedUnexpectedly = true
      console.error(
        `Keymaxxer Sidecar exited while the wrapped command was running (code ${code ?? "?"})`,
      )
      wrappedChild?.kill("SIGTERM")
    }
  })
}
