import { spawn } from "node:child_process"
import { resolve, sep } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { DatabaseLive, runConfiguredMigrations } from "@ready-for-agent/db"
import {
  KEYMAXXER_SIDECAR_URL_PREFIX,
  isKeymaxxerAvailable,
} from "@ready-for-agent/keymaxxer-service"
import type { ApplicationRequestContext } from "../server-context.js"
import { type Application, createApplication } from "./application.server.js"
import {
  browserOpenCommand,
  hasNoOpenFlag,
  shouldOpenBrowser,
} from "./browser-open.js"

export type ProductionLifecycleEvent =
  | "database-ready"
  | "sidecar-ready"
  | "application-ready"
  | "http-ready"
  | "browser-open"
  | "shutdown-start"
  | "shutdown-complete"
  | "child-failed"

export type OwnedChildProcess = {
  readonly kill: (signal?: NodeJS.Signals) => boolean
  readonly on: (
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ) => void
}

export type HttpServerHandle = {
  readonly port: number
  readonly stop: (closeActiveConnections?: boolean) => Promise<void> | void
}

export type StartHandler = {
  fetch: (
    request: Request,
    options: { context: ApplicationRequestContext },
  ) => Response | Promise<Response>
}

export type KeymaxxerMode =
  | { readonly kind: "disabled" }
  | { readonly kind: "existing-url"; readonly url: string }
  | { readonly kind: "spawn-sidecar" }

export type ProductionLifecycleOptions = {
  readonly environment?: NodeJS.ProcessEnv
  readonly argv?: ReadonlyArray<string>
  readonly hostname?: string
  readonly port?: number
  readonly clientDirectory?: string
  readonly serverEntryPath?: string
  readonly sidecarEntryPath?: string
  readonly workspaceRoot?: string
  readonly sidecarBootstrapTimeoutMs?: number
  readonly applyMigrations?: (environment: NodeJS.ProcessEnv) => Promise<void>
  readonly resolveKeymaxxerMode?: (
    environment: NodeJS.ProcessEnv,
  ) => KeymaxxerMode
  readonly startSidecar?: (environment: NodeJS.ProcessEnv) => Promise<{
    readonly url: string
    readonly child: OwnedChildProcess
  }>
  readonly createApplication?: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<Application>
  readonly loadStartHandler?: () => Promise<StartHandler>
  readonly serveHttp?: (input: {
    readonly hostname: string
    readonly port: number
    readonly clientDirectory: string
    readonly handler: StartHandler
    readonly context: ApplicationRequestContext
  }) => Promise<HttpServerHandle>
  readonly openBrowser?: (url: string) => void
  readonly onEvent?: (event: ProductionLifecycleEvent) => void
  readonly logInfo?: (message: string) => void
  readonly logError?: (message: string) => void
  readonly installSignalHandlers?: (
    shutdown: (signal: NodeJS.Signals) => void,
  ) => () => void
  readonly exitProcess?: (code: number) => void
  /** When false, return after HTTP readiness instead of waiting for signals. */
  readonly waitForShutdown?: boolean
}

export type ProductionLifecycleHandle = {
  readonly url: string
  readonly dispose: () => Promise<void>
}

const defaultWorkspaceRoot = fileURLToPath(
  new URL("../../../..", import.meta.url),
)

const defaultSidecarEntryPath = fileURLToPath(
  new URL("../../../keymaxxer-sidecar/src/main.ts", import.meta.url),
)

const defaultClientDirectory = resolve(
  fileURLToPath(new URL("../../dist/client", import.meta.url)),
)

const defaultServerEntryPath = fileURLToPath(
  new URL("../../dist/server/server.js", import.meta.url),
)

export const resolveKeymaxxerMode = (
  environment: NodeJS.ProcessEnv,
): KeymaxxerMode => {
  const existingUrl = environment.KEYMAXXER_SIDECAR_URL?.trim()
  const keymaxxerAvailable = isKeymaxxerAvailable(environment)
  const explicitlyDisabled =
    environment.KEYMAXXER_ENABLED?.trim().toLowerCase() === "false"
  const keymaxxerEnabled =
    !explicitlyDisabled &&
    ((existingUrl !== undefined && existingUrl !== "") || keymaxxerAvailable)

  if (!keymaxxerEnabled) {
    return { kind: "disabled" }
  }
  if (existingUrl) {
    return { kind: "existing-url", url: existingUrl }
  }
  return { kind: "spawn-sidecar" }
}

export const applyProductionMigrations = async (
  _environment: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  await Effect.runPromise(
    runConfiguredMigrations.pipe(
      Effect.provide(DatabaseLive),
      Effect.tap(() =>
        Effect.sync(() => {
          console.info("Database migrations applied")
        }),
      ),
    ),
  )
}

export const startOwnedSidecar = (input: {
  readonly environment: NodeJS.ProcessEnv
  readonly sidecarEntryPath: string
  readonly workspaceRoot: string
  readonly bootstrapTimeoutMs: number
  readonly logError?: (message: string) => void
}): Promise<{
  readonly url: string
  readonly child: OwnedChildProcess
}> =>
  new Promise((resolvePromise, reject) => {
    const sidecar = spawn(
      process.execPath,
      ["--conditions", "@ready-for-agent/source", input.sidecarEntryPath],
      {
        cwd: input.workspaceRoot,
        env: input.environment,
        stdio: ["ignore", "pipe", "inherit"],
      },
    )

    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      input.logError?.(message)
      sidecar.kill("SIGTERM")
      reject(new Error(message))
    }

    const timeout = setTimeout(() => {
      fail("Timed out waiting for Keymaxxer Sidecar bootstrap URL")
    }, input.bootstrapTimeoutMs)

    if (sidecar.stdout === null) {
      fail("Keymaxxer Sidecar stdout was not captured")
      return
    }

    const lines = createInterface({ input: sidecar.stdout })
    lines.on("line", (line) => {
      if (!line.startsWith(KEYMAXXER_SIDECAR_URL_PREFIX)) return
      if (settled) return
      settled = true
      clearTimeout(timeout)
      lines.close()
      const url = line.slice(KEYMAXXER_SIDECAR_URL_PREFIX.length).trim()
      resolvePromise({
        url,
        child: sidecar,
      })
    })

    sidecar.on("exit", (code) => {
      if (!settled) {
        fail(`Keymaxxer Sidecar exited before bootstrap (code ${code ?? "?"})`)
      }
    })

    sidecar.on("error", (error) => {
      fail(
        error instanceof Error
          ? error.message
          : "Keymaxxer Sidecar failed to start",
      )
    })
  })

const openDefaultBrowser = (url: string) => {
  const launch = browserOpenCommand(process.platform, url)
  try {
    spawn(launch.command, [...launch.args], {
      detached: true,
      stdio: "ignore",
    }).unref()
  } catch {
    // Browser open is best-effort; start still succeeds.
  }
}

const serveStaticAsset = async (request: Request, clientDirectory: string) => {
  const url = new URL(request.url)
  if (url.pathname === "/" || url.pathname.endsWith("/")) return undefined

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }

  const filePath = resolve(clientDirectory, `.${pathname}`)
  if (!filePath.startsWith(`${clientDirectory}${sep}`)) return undefined

  const file = Bun.file(filePath)
  if (!(await file.exists())) return undefined

  return new Response(file, {
    headers: {
      "cache-control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  })
}

const defaultServeHttp = async (input: {
  readonly hostname: string
  readonly port: number
  readonly clientDirectory: string
  readonly handler: StartHandler
  readonly context: ApplicationRequestContext
}): Promise<HttpServerHandle> => {
  const server = Bun.serve({
    hostname: input.hostname,
    port: input.port,
    async fetch(request) {
      if (new URL(request.url).hostname !== input.hostname) {
        return new Response("Invalid Host", { status: 421 })
      }

      const assetResponse = await serveStaticAsset(
        request,
        input.clientDirectory,
      )
      return (
        assetResponse ??
        input.handler.fetch(request, { context: input.context })
      )
    },
  })

  const listenPort = server.port
  if (listenPort === undefined) {
    await server.stop(true)
    throw new Error("HTTP server did not bind a TCP port")
  }

  return {
    port: listenPort,
    stop: (closeActiveConnections = true) =>
      server.stop(closeActiveConnections),
  }
}

const defaultInstallSignalHandlers = (
  shutdown: (signal: NodeJS.Signals) => void,
) => {
  const onSigint = () => shutdown("SIGINT")
  const onSigterm = () => shutdown("SIGTERM")
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  return () => {
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
  }
}

/**
 * One production owner for database preparation, Keymaxxer Sidecar
 * coordination, application runtime, HTTP listen, browser open, and cleanup.
 */
export const startProductionLifecycle = async (
  options: ProductionLifecycleOptions = {},
): Promise<ProductionLifecycleHandle> => {
  const environment = { ...(options.environment ?? process.env) }
  const argv = options.argv ?? process.argv
  const hostname = options.hostname ?? "127.0.0.1"
  const port = options.port ?? Number(environment.PORT ?? 4200)
  const clientDirectory = options.clientDirectory ?? defaultClientDirectory
  const serverEntryPath = options.serverEntryPath ?? defaultServerEntryPath
  const sidecarEntryPath = options.sidecarEntryPath ?? defaultSidecarEntryPath
  const workspaceRoot = options.workspaceRoot ?? defaultWorkspaceRoot
  const bootstrapTimeoutMs = options.sidecarBootstrapTimeoutMs ?? 15_000
  const onEvent = options.onEvent ?? (() => {})
  const logInfo = options.logInfo ?? ((message) => console.info(message))
  const logError = options.logError ?? ((message) => console.error(message))
  const exitProcess = options.exitProcess ?? ((code) => process.exit(code))
  const waitForShutdown = options.waitForShutdown !== false

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port")
  }

  const applyMigrations = options.applyMigrations ?? applyProductionMigrations
  const resolveMode = options.resolveKeymaxxerMode ?? resolveKeymaxxerMode
  const startSidecar =
    options.startSidecar ??
    ((env) =>
      startOwnedSidecar({
        environment: env,
        sidecarEntryPath,
        workspaceRoot,
        bootstrapTimeoutMs,
        logError,
      }))
  const createApp = options.createApplication ?? createApplication
  const loadStartHandler =
    options.loadStartHandler ??
    (async () => {
      const serverModule = (await import(serverEntryPath)) as {
        default: StartHandler
      }
      return serverModule.default
    })
  const serveHttp = options.serveHttp ?? defaultServeHttp
  const openBrowser = options.openBrowser ?? openDefaultBrowser
  const installSignalHandlers =
    options.installSignalHandlers ?? defaultInstallSignalHandlers

  await applyMigrations(environment)
  onEvent("database-ready")

  const mode = resolveMode(environment)
  let ownedChild: OwnedChildProcess | undefined
  let applicationEnv: NodeJS.ProcessEnv = { ...environment }

  if (mode.kind === "disabled") {
    applicationEnv = { ...environment, KEYMAXXER_ENABLED: "false" }
    delete applicationEnv.KEYMAXXER_SIDECAR_URL
  } else if (mode.kind === "existing-url") {
    applicationEnv = {
      ...environment,
      KEYMAXXER_SIDECAR_URL: mode.url,
    }
    onEvent("sidecar-ready")
  } else {
    const started = await startSidecar(environment)
    ownedChild = started.child
    applicationEnv = {
      ...environment,
      KEYMAXXER_SIDECAR_URL: started.url,
    }
    onEvent("sidecar-ready")
  }

  let application: Application | undefined
  let server: HttpServerHandle | undefined
  let shuttingDown = false
  let removeSignalHandlers = () => {}
  let childFailed = false

  const dispose = async () => {
    if (shuttingDown) return
    shuttingDown = true
    onEvent("shutdown-start")
    removeSignalHandlers()
    if (server !== undefined) {
      await server.stop(true)
    }
    if (application !== undefined) {
      await application.dispose()
    }
    ownedChild?.kill("SIGTERM")
    onEvent("shutdown-complete")
  }

  try {
    application = await createApp(applicationEnv)
    onEvent("application-ready")

    const handler = await loadStartHandler()
    server = await serveHttp({
      hostname,
      port,
      clientDirectory,
      handler,
      context: application.context,
    })
  } catch (error) {
    await dispose()
    throw error
  }

  const listenUrl = `http://${hostname}:${server.port}/`
  logInfo(`Ready for Agent listening on ${listenUrl.slice(0, -1)}`)
  onEvent("http-ready")

  if (
    shouldOpenBrowser({
      noOpenFlag: hasNoOpenFlag(argv),
      env: {
        NO_BROWSER: environment.NO_BROWSER,
        PORT: String(server.port),
      },
    })
  ) {
    openBrowser(listenUrl)
    onEvent("browser-open")
  }

  if (ownedChild !== undefined) {
    ownedChild.on("exit", (code, signal) => {
      if (shuttingDown) return
      childFailed = true
      onEvent("child-failed")
      logError(
        `Keymaxxer Sidecar exited while the Harness was running (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""})`,
      )
      void dispose().finally(() => {
        exitProcess(1)
      })
    })
  }

  removeSignalHandlers = installSignalHandlers((signal) => {
    void dispose().finally(() => {
      if (childFailed) {
        exitProcess(1)
        return
      }
      if (signal === "SIGINT" || signal === "SIGTERM") {
        exitProcess(0)
      }
    })
  })

  if (waitForShutdown) {
    await new Promise<never>(() => {})
  }

  return { url: listenUrl, dispose }
}
