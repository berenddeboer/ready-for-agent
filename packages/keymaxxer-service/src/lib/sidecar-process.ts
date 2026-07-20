import { defaultKeymaxxerSidecarPort } from "./config.js"
import { startKeymaxxerFacade } from "./facade.js"

export { defaultKeymaxxerSidecarPort } from "./config.js"

/** Hidden argv token: re-enter the same executable as the Keymaxxer Sidecar. */
export const INTERNAL_KEYMAXXER_SIDECAR_ARG =
  "--ready-for-agent-internal-keymaxxer-sidecar"

export const keymaxxerSidecarHost = "127.0.0.1"

export const isInternalKeymaxxerSidecarMode = (
  argv: ReadonlyArray<string> = process.argv,
): boolean => argv.includes(INTERNAL_KEYMAXXER_SIDECAR_ARG)

export const keymaxxerSidecarPortFromEnvironment = (
  environment: Partial<Record<string, string | undefined>>,
) => {
  const value = environment.KEYMAXXER_SIDECAR_PORT?.trim()
  if (value === undefined || value === "") return defaultKeymaxxerSidecarPort

  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("KEYMAXXER_SIDECAR_PORT must be a valid TCP port")
  }
  return port
}

/**
 * True when this process is a compiled standalone product binary rather than
 * `bun path/to/script.ts` (or similar source execution).
 */
export const isStandaloneExecutable = (
  execPath: string = process.execPath,
  argv: ReadonlyArray<string> = process.argv,
): boolean => {
  const base = execPath.split(/[/\\]/).pop() ?? ""
  if (
    base === "bun" ||
    base === "bun.exe" ||
    base === "node" ||
    base === "node.exe"
  ) {
    return false
  }
  const maybeScript = argv[1]
  if (
    maybeScript !== undefined &&
    /\.(m?[jt]sx?|cjs|mts|cts)$/i.test(maybeScript)
  ) {
    return false
  }
  return true
}

export type SidecarChildSpawn = {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

/**
 * How the production parent should re-exec this program as the Sidecar child.
 * Compiled binaries: `execPath --ready-for-agent-internal-keymaxxer-sidecar`.
 * Source: same Bun runtime + current entry script + the internal mode flag.
 */
export const resolveKeymaxxerSidecarChildSpawn = (
  input: {
    readonly execPath?: string
    readonly argv?: ReadonlyArray<string>
    readonly sourceConditions?: ReadonlyArray<string>
  } = {},
): SidecarChildSpawn => {
  const execPath = input.execPath ?? process.execPath
  const argv = input.argv ?? process.argv

  if (isStandaloneExecutable(execPath, argv)) {
    return {
      command: execPath,
      args: [INTERNAL_KEYMAXXER_SIDECAR_ARG],
    }
  }

  const script = argv[1]
  if (script === undefined || script === "") {
    throw new Error(
      "Cannot resolve Keymaxxer Sidecar spawn: no script entry for source runtime",
    )
  }

  const conditions = input.sourceConditions ?? [
    "--conditions",
    "@ready-for-agent/source",
  ]

  return {
    command: execPath,
    args: [...conditions, script, INTERNAL_KEYMAXXER_SIDECAR_ARG],
  }
}

export type RunKeymaxxerSidecarProcessOptions = {
  readonly environment?: Partial<Record<string, string | undefined>>
  readonly exitProcess?: (code: number) => void
  readonly waitForever?: () => Promise<void>
}

/**
 * Sidecar process body: listen, bootstrap URL on stdout, stop on signals.
 * Shared by the standalone sidecar app and the production binary's internal mode.
 */
export const runKeymaxxerSidecarProcess = async (
  options: RunKeymaxxerSidecarProcessOptions = {},
): Promise<void> => {
  const environment = options.environment ?? process.env
  const exitProcess = options.exitProcess ?? ((code) => process.exit(code))
  const waitForever = options.waitForever ?? (() => new Promise<void>(() => {}))
  const port = keymaxxerSidecarPortFromEnvironment(environment)

  try {
    const facade = await startKeymaxxerFacade({
      host: keymaxxerSidecarHost,
      port,
      environment,
    })

    const stop = async () => {
      await facade.stop()
      exitProcess(0)
    }
    process.once("SIGINT", () => {
      void stop()
    })
    process.once("SIGTERM", () => {
      void stop()
    })
    await waitForever()
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Keymaxxer Sidecar failed to listen on ${keymaxxerSidecarHost}:${port}. Set KEYMAXXER_SIDECAR_PORT to an unused port.`
    // Process boundary: single-line stderr for topology tests; no Effect error channel.
    console.error(
      message.startsWith("Keymaxxer Sidecar failed")
        ? message
        : `Keymaxxer Sidecar failed to listen on ${keymaxxerSidecarHost}:${port}. Set KEYMAXXER_SIDECAR_PORT to an unused port.`,
    )
    exitProcess(1)
  }
}
