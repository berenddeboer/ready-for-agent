/**
 * Dev entry for `harness:dev`: preflight, then Vite.
 *
 * Nx appends unknown flags (e.g. `--host`) onto this process. Resolve them to
 * `HOST` before spawning Vite so bind matches production / operator CLI.
 */
import { spawn, spawnSync } from "node:child_process"
import { parseHostFlagFromArgv, resolveListenHost } from "./listen-host.ts"

/** Resolve bind host for dev (CLI flag wins over HOST env). */
export const resolveDevListenHost = (
  argv: ReadonlyArray<string>,
  envHost: string | undefined,
): string =>
  resolveListenHost({
    flag: parseHostFlagFromArgv(argv),
    env: envHost,
  })

/**
 * Apply operator bind host to env only when `--host` or non-empty `HOST` is set.
 * Leaves `HOST` unset for the default loopback path.
 */
export const applyDevListenHostEnv = (
  env: NodeJS.ProcessEnv,
  argv: ReadonlyArray<string>,
): void => {
  const flag = parseHostFlagFromArgv(argv)
  const envHost = env.HOST
  if (flag === undefined && (envHost === undefined || envHost.trim() === "")) {
    return
  }
  env.HOST = resolveListenHost({ flag, env: envHost })
}

const bunArgs = (script: string) => [
  "--conditions",
  "@ready-for-agent/source",
  script,
]

const main = () => {
  applyDevListenHostEnv(process.env, process.argv)

  const preflight = spawnSync(
    process.execPath,
    bunArgs("src/server/preflight.ts"),
    { stdio: "inherit", env: process.env },
  )
  if (preflight.status !== 0) {
    process.exit(preflight.status ?? 1)
  }

  const vite = spawn(
    process.execPath,
    bunArgs("./node_modules/vite/bin/vite.js"),
    { stdio: "inherit", env: process.env },
  )

  const shutdown = (signal: NodeJS.Signals) => {
    vite.kill(signal)
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))

  vite.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 1)
  })
}

if (import.meta.main) {
  main()
}
