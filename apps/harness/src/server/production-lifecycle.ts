import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import {
  Cause,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Scope,
  Stream,
  pipe,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  DatabaseLive,
  logMigrationsAppliedIfAny,
  runConfiguredMigrations,
} from "@ready-for-agent/db"
import {
  KEYMAXXER_SIDECAR_URL_PREFIX,
  type SidecarChildSpawn,
  isKeymaxxerAvailable,
  resolveKeymaxxerSidecarChildSpawn,
} from "@ready-for-agent/keymaxxer-service"
import type { ApplicationRequestContext } from "../application-request-context.js"
import { READY_FOR_AGENT_VERSION } from "../generated/version.js"
import { type Application, createApplication } from "./application.server.js"
import { environmentConfigLayer, loadPort } from "./application-config.js"
import {
  hasNoOpenFlag,
  launchDetachedBrowser,
  shouldOpenBrowser,
} from "./browser-open.js"
import {
  formatListenUrl,
  isRequestHostAdmitted,
  parseHostFlagFromArgv,
  resolveBrowserOpenUrl,
  resolveListenHost,
} from "./listen-host.js"
import {
  type EmbeddedClientAssets,
  type StartHandler,
  serveStaticAssetFromDirectory,
  serveStaticAssetFromEmbed,
} from "./production-static.js"

export type { Application }

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
  /** When set, static assets are served from embedded Bun file paths. */
  readonly embeddedClientAssets?: EmbeddedClientAssets
  /** Override how the owned Sidecar child is spawned (tests / custom hosts). */
  readonly sidecarSpawn?: SidecarChildSpawn
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
    readonly embeddedClientAssets?: EmbeddedClientAssets
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
  /**
   * Build-time product version shown in the readiness log (`v<semver>`).
   * Defaults to the launcher package version embedded at build time.
   */
  readonly version?: string
}

export type ProductionLifecycleHandle = {
  readonly url: string
  readonly dispose: () => Promise<void>
}

/**
 * Production Bun.serve idle timeout (seconds). Must stay strictly longer than
 * GraphQL Yoga's production SSE heartbeat (12s interval pings). Bun's default
 * is 10s, which closes quiet subscriptions before the first interval ping.
 */
export const PRODUCTION_HTTP_IDLE_TIMEOUT_SECONDS = 30

const defaultClientDirectory = resolve(
  fileURLToPath(new URL("../../dist/client", import.meta.url)),
)

const defaultServerEntryPath = fileURLToPath(
  new URL("../../dist/server/server.js", import.meta.url),
)

/**
 * Map a multi-reason Scope-close Cause into the disposal contract tests and
 * operators expect: a single error, or AggregateError when several finalizers
 * failed. Effect's runPromise squash only surfaces the first reason, so multi
 * finalizer defects are collapsed into one AggregateError defect first.
 */
const disposalErrorFromCause = (cause: Cause.Cause<unknown>): unknown => {
  const errors: unknown[] = []
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      errors.push(reason.error)
    } else if (Cause.isDieReason(reason)) {
      errors.push(reason.defect)
    }
  }
  if (errors.length === 0) {
    return new Error("Production lifecycle disposal failed")
  }
  if (errors.length === 1) {
    return errors[0]
  }
  return new AggregateError(errors, "Production lifecycle disposal failed")
}

/** Release helpers must be `E = never` for acquireRelease; rejections die. */
const releasePromise = (run: () => Promise<void> | void): Effect.Effect<void> =>
  Effect.promise(async () => {
    await run()
  })

const releaseSync = (run: () => void): Effect.Effect<void> => Effect.sync(run)

const dieMessage = (message: string): Effect.Effect<never> =>
  Effect.die(new Error(message))

const sanitizeEnv = (
  environment: NodeJS.ProcessEnv,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

export const resolveKeymaxxerMode = (
  environment: NodeJS.ProcessEnv,
  keymaxxerAvailable: (
    environment: NodeJS.ProcessEnv,
  ) => boolean = isKeymaxxerAvailable,
): KeymaxxerMode => {
  const existingUrl = environment.KEYMAXXER_SIDECAR_URL?.trim()
  const available = keymaxxerAvailable(environment)
  const explicitlyDisabled =
    environment.KEYMAXXER_ENABLED?.trim().toLowerCase() === "false"
  const keymaxxerEnabled =
    !explicitlyDisabled &&
    ((existingUrl !== undefined && existingUrl !== "") || available)

  if (!keymaxxerEnabled) {
    return { kind: "disabled" }
  }
  if (existingUrl) {
    return { kind: "existing-url", url: existingUrl }
  }
  return { kind: "spawn-sidecar" }
}

const applyProductionMigrations = async (
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  await Effect.runPromise(
    runConfiguredMigrations().pipe(
      Effect.provide(
        DatabaseLive.pipe(Layer.provide(environmentConfigLayer(environment))),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          logMigrationsAppliedIfAny(result)
        }),
      ),
    ),
  )
}

/**
 * How long to wait after SIGTERM before escalating to SIGKILL for an owned
 * Sidecar. Platform `forceKillAfter` only times out *sending* the signal, not
 * awaiting exit — hang safety is implemented in `terminateOwnedSidecar`.
 */
const SIDECAR_FORCE_KILL_AFTER = Duration.seconds(2)

/** Brief grace after SIGKILL before giving up on exit observation. */
const SIDECAR_SIGKILL_WAIT = Duration.seconds(1)

/** Platform exitCode fails on signal death with this message shape (on cause). */
const SIGNAL_FROM_EXIT_MESSAGE =
  /Process interrupted due to receipt of signal: '([^']+)'/

/**
 * Collect messages from an error and nested cause/reason chain.
 * PlatformError.message is a SystemError summary; the signal text lives on cause.
 */
const collectErrorMessages = (error: unknown): string => {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (typeof current === "string") {
      parts.push(current)
      break
    }
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
      continue
    }
    if (typeof current === "object") {
      const record = current as {
        message?: unknown
        cause?: unknown
        reason?: unknown
      }
      if (typeof record.message === "string") {
        parts.push(record.message)
      }
      if (record.cause !== undefined) {
        current = record.cause
        continue
      }
      if (record.reason !== undefined) {
        current = record.reason
        continue
      }
    }
    break
  }
  return parts.join("\n")
}

const parseSignalFromExitError = (error: unknown): NodeJS.Signals | null => {
  const match = SIGNAL_FROM_EXIT_MESSAGE.exec(collectErrorMessages(error))
  if (match === null || match[1] === undefined) {
    return null
  }
  return match[1] as NodeJS.Signals
}

const sendSignal = (pid: number, signal: NodeJS.Signals): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(pid, signal)
    } catch {
      // Already exited or unsignallable.
    }
  })

/**
 * Hang-safe Sidecar teardown: SIGTERM, wait up to SIDECAR_FORCE_KILL_AFTER,
 * then SIGKILL. Does not use handle.kill (platform forceKillAfter does not
 * bound Deferred.await(exit)).
 */
const terminateOwnedSidecar = (
  handle: ChildProcessHandle,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const running = yield* handle.isRunning.pipe(Effect.orDie)
    if (!running) {
      return
    }
    const pid = Number(handle.pid)
    yield* sendSignal(pid, "SIGTERM")
    // exitCode succeeds on numeric exit; fails on signal death — both mean gone.
    yield* handle.exitCode.pipe(
      Effect.ignore,
      Effect.timeout(SIDECAR_FORCE_KILL_AFTER),
      Effect.catchTag("TimeoutError", () =>
        sendSignal(pid, "SIGKILL").pipe(
          Effect.andThen(
            handle.exitCode.pipe(
              Effect.ignore,
              Effect.timeout(SIDECAR_SIGKILL_WAIT),
              Effect.ignore,
            ),
          ),
        ),
      ),
    )
  })

/** Fire-and-forget Effect on the Promise host without unhandled rejections. */
const runDetached = (effect: Effect.Effect<void>): void => {
  void Effect.runPromise(effect).catch(() => {})
}

/**
 * Adapt a ChildProcessHandle to the Promise-side OwnedChildProcess surface used
 * by the child-exit watchdog and test fakes.
 *
 * Platform `exitCode` succeeds only when Node reports a numeric code; signal
 * deaths fail with PlatformError. The watchdog must treat both as termination.
 *
 * Teardown ownership lives on the ambient Scope finalizer (hang-safe terminate);
 * `kill` is best-effort only for callers that still invoke it.
 */
const ownedChildFromHandle = (
  handle: ChildProcessHandle,
): OwnedChildProcess => ({
  kill: (_signal = "SIGTERM") => {
    runDetached(terminateOwnedSidecar(handle))
    return true
  },
  on: (event, listener) => {
    if (event !== "exit") return
    runDetached(
      handle.exitCode.pipe(
        Effect.matchEffect({
          onSuccess: (code) =>
            Effect.sync(() => {
              listener(Number(code), null)
            }),
          onFailure: (error) =>
            Effect.sync(() => {
              listener(null, parseSignalFromExitError(error))
            }),
        }),
      ),
    )
  },
})

/**
 * Spawn the owned Keymaxxer Sidecar, wait for the bootstrap URL (timeout + race
 * against early exit). Immediately unrefs the platform-owned process so the
 * spawner Scope finalizer never unbounded-awaits exit; hang-safe terminate is
 * the sole teardown path (finalizer + bootstrap-failure cleanup).
 */
const startOwnedSidecar = (input: {
  readonly environment: NodeJS.ProcessEnv
  readonly spawn: SidecarChildSpawn
  readonly bootstrapTimeoutMs: number
  readonly logError?: (message: string) => void
}): Effect.Effect<
  {
    readonly url: string
    readonly child: OwnedChildProcess
  },
  never,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const command = ChildProcess.make(
      input.spawn.command,
      [...input.spawn.args],
      {
        env: sanitizeEnv(input.environment),
        extendEnv: false,
        // Match prior node:child_process.spawn (non-detached); lifecycle owns the child.
        detached: false,
        killSignal: "SIGTERM",
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      },
    )

    const handle = yield* spawner.spawn(command).pipe(Effect.orDie)

    // Own teardown before bootstrap wait so failure Scope.close cannot hang in
    // the platform finalizer (unref no-ops it; we terminate hang-safely ourselves).
    // Discard Reref — we never re-attach the child to the process refcount.
    yield* handle.unref.pipe(Effect.asVoid, Effect.orDie)
    yield* Effect.addFinalizer(() => terminateOwnedSidecar(handle))

    const bootstrapUrl = pipe(
      Stream.decodeText(handle.stdout),
      Stream.splitLines,
      Stream.filter((line) => line.startsWith(KEYMAXXER_SIDECAR_URL_PREFIX)),
      Stream.map((line) =>
        line.slice(KEYMAXXER_SIDECAR_URL_PREFIX.length).trim(),
      ),
      Stream.take(1),
      Stream.runHead,
      Effect.orDie,
      Effect.flatMap((url) =>
        Option.isSome(url)
          ? Effect.succeed(url.value)
          : dieMessage("Keymaxxer Sidecar stdout closed before bootstrap URL"),
      ),
    )

    // exitCode fails on signal death; map both outcomes to the same bootstrap fail.
    const earlyExit = handle.exitCode.pipe(
      Effect.matchEffect({
        onSuccess: (code) =>
          dieMessage(
            `Keymaxxer Sidecar exited before bootstrap (code ${Number(code)})`,
          ),
        onFailure: (error) => {
          const signal = parseSignalFromExitError(error)
          return dieMessage(
            signal !== null
              ? `Keymaxxer Sidecar exited before bootstrap (code ?, signal ${signal})`
              : "Keymaxxer Sidecar exited before bootstrap (code ?)",
          )
        },
      }),
    )

    // raceFirst: first completion wins (including earlyExit Die). Effect.race is
    // first-success only, so a dying Sidecar would not fail-fast until timeout/EOF.
    const url = yield* Effect.raceFirst(bootstrapUrl, earlyExit).pipe(
      Effect.timeout(Duration.millis(input.bootstrapTimeoutMs)),
      Effect.catchTag("TimeoutError", () =>
        dieMessage("Timed out waiting for Keymaxxer Sidecar bootstrap URL"),
      ),
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          const defect = Cause.squash(cause)
          const message =
            defect instanceof Error ? defect.message : String(defect)
          yield* Effect.sync(() => input.logError?.(message))
          // Immediate hang-safe kill; Scope finalizer will no-op if already dead.
          yield* terminateOwnedSidecar(handle)
        }),
      ),
    )

    return {
      url,
      child: ownedChildFromHandle(handle),
    }
  })

const openDefaultBrowser = (url: string) => {
  // Best-effort only: missing/failing openers must not fail production start.
  // The GUI remains detached (see launchDetachedBrowser).
  launchDetachedBrowser(process.platform, url)
}

const defaultServeHttp = async (input: {
  readonly hostname: string
  readonly port: number
  readonly clientDirectory: string
  readonly embeddedClientAssets?: EmbeddedClientAssets
  readonly handler: StartHandler
  readonly context: ApplicationRequestContext
}): Promise<HttpServerHandle> => {
  const server = Bun.serve({
    hostname: input.hostname,
    port: input.port,
    idleTimeout: PRODUCTION_HTTP_IDLE_TIMEOUT_SECONDS,
    async fetch(request) {
      const requestHostname = new URL(request.url).hostname
      if (
        !isRequestHostAdmitted({
          requestHostname,
          bindHostname: input.hostname,
        })
      ) {
        return new Response("Invalid Host", { status: 421 })
      }

      const assetResponse =
        input.embeddedClientAssets !== undefined
          ? await serveStaticAssetFromEmbed(request, input.embeddedClientAssets)
          : await serveStaticAssetFromDirectory(request, input.clientDirectory)
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
 * Intentional Promise host boundary for Bun HTTP, process signals, detached
 * browser launch, and shutdown triggers. Inside this boundary, resource
 * orchestration (migrations → sidecar → application → HTTP) uses Effect Scope
 * + acquireRelease so teardown is reverse-order, memoized on dispose, and
 * partial acquisition cleans up automatically. See ADR 0045.
 */
export const startProductionLifecycle = async (
  options: ProductionLifecycleOptions = {},
): Promise<ProductionLifecycleHandle> => {
  const environment = { ...(options.environment ?? process.env) }
  const argv = options.argv ?? process.argv
  const hostname =
    options.hostname ??
    resolveListenHost({
      flag: parseHostFlagFromArgv(argv),
      env: environment.HOST,
    })
  const port = options.port ?? (await Effect.runPromise(loadPort(environment)))
  const clientDirectory = options.clientDirectory ?? defaultClientDirectory
  const serverEntryPath = options.serverEntryPath ?? defaultServerEntryPath
  const embeddedClientAssets = options.embeddedClientAssets
  const sidecarSpawn =
    options.sidecarSpawn ?? resolveKeymaxxerSidecarChildSpawn()
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
  const customStartSidecar = options.startSidecar
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
  const scope = await Effect.runPromise(Scope.make("sequential"))

  let shuttingDown = false
  let removeSignalHandlers = () => {}
  let childFailed = false
  /** Shared disposal promise so concurrent callers await the same cleanup. */
  let disposePromise: Promise<void> | undefined

  const dispose = (): Promise<void> => {
    if (disposePromise !== undefined) {
      return disposePromise
    }
    shuttingDown = true
    disposePromise = Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          onEvent("shutdown-start")
          removeSignalHandlers()
        })
        const closeExit = yield* Effect.exit(Scope.close(scope, Exit.void))
        yield* Effect.sync(() => {
          onEvent("shutdown-complete")
        })
        if (Exit.isFailure(closeExit)) {
          return yield* Effect.die(disposalErrorFromCause(closeExit.cause))
        }
      }),
    )
    return disposePromise
  }

  const processLayer = BunChildProcessSpawner.layer.pipe(
    Layer.provideMerge(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  )

  // Sidecar acquisition is outside the app/HTTP try/catch: a refused or
  // timed-out sidecar must fail startup without dispose/shutdown events.
  // On failure we still close the Scope so ChildProcessSpawner finalizers run
  // (process already SIGTERM'd on bootstrap failure) without onEvent hooks.
  let applicationEnv: NodeJS.ProcessEnv
  let ownedChild: OwnedChildProcess | undefined
  try {
    const sidecarPhase = await Effect.runPromise(
      Scope.provide(scope)(
        Effect.gen(function* () {
          if (mode.kind === "disabled") {
            const disabledEnv: NodeJS.ProcessEnv = {
              ...environment,
              KEYMAXXER_ENABLED: "false",
            }
            delete disabledEnv.KEYMAXXER_SIDECAR_URL
            return {
              applicationEnv: disabledEnv,
              ownedChild: undefined as OwnedChildProcess | undefined,
            }
          }

          if (mode.kind === "existing-url") {
            yield* Effect.sync(() => {
              onEvent("sidecar-ready")
            })
            return {
              applicationEnv: {
                ...environment,
                KEYMAXXER_SIDECAR_URL: mode.url,
              },
              ownedChild: undefined as OwnedChildProcess | undefined,
            }
          }

          // Custom/test fakes need an outer kill; the default spawn path owns
          // hang-safe terminate via Scope finalizer after unref (no double kill).
          const useCustomSidecar = customStartSidecar !== undefined
          const started = yield* Effect.acquireRelease(
            useCustomSidecar
              ? Effect.promise(() => customStartSidecar(environment))
              : startOwnedSidecar({
                  environment,
                  spawn: sidecarSpawn,
                  bootstrapTimeoutMs,
                  logError,
                }),
            ({ child }) =>
              useCustomSidecar
                ? releaseSync(() => {
                    child.kill("SIGTERM")
                  })
                : Effect.void,
          )

          yield* Effect.sync(() => {
            onEvent("sidecar-ready")
          })

          return {
            applicationEnv: {
              ...environment,
              KEYMAXXER_SIDECAR_URL: started.url,
            },
            ownedChild: started.child as OwnedChildProcess | undefined,
          }
        }),
      ).pipe(Effect.provide(processLayer)),
    )
    applicationEnv = sidecarPhase.applicationEnv
    ownedChild = sidecarPhase.ownedChild
  } catch (error) {
    // Prefer the original startup error (sidecar refused / bootstrap timeout).
    // Scope.close must not replace it if finalizers fail.
    try {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    } catch (cleanupError) {
      logError(
        `Production lifecycle disposal failed during startup recovery: ${
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError)
        }`,
      )
    }
    throw error
  }

  let listenUrl: string
  let listenPort: number

  try {
    const startedHttp = await Effect.runPromise(
      Scope.provide(scope)(
        Effect.gen(function* () {
          const application = yield* Effect.acquireRelease(
            Effect.promise(() => createApp(applicationEnv)).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  onEvent("application-ready")
                }),
              ),
            ),
            (app) => releasePromise(() => app.dispose()),
          )

          const handler = yield* Effect.promise(() => loadStartHandler())

          const server = yield* Effect.acquireRelease(
            Effect.promise(() =>
              serveHttp({
                hostname,
                port,
                clientDirectory,
                embeddedClientAssets,
                handler,
                context: application.context,
              }),
            ),
            (httpServer) => releasePromise(() => httpServer.stop(true)),
          )

          return {
            listenUrl: formatListenUrl(hostname, server.port),
            listenPort: server.port,
          }
        }),
      ).pipe(Effect.provide(processLayer)),
    )
    listenUrl = startedHttp.listenUrl
    listenPort = startedHttp.listenPort
  } catch (error) {
    try {
      await dispose()
    } catch (disposalError) {
      // Prefer the original startup error, but keep disposal failures diagnosable.
      logError(
        `Production lifecycle disposal failed during startup recovery: ${
          disposalError instanceof Error
            ? disposalError.message
            : String(disposalError)
        }`,
      )
    }
    throw error
  }

  const releaseVersion = options.version ?? READY_FOR_AGENT_VERSION
  logInfo(
    `Ready for Agent v${releaseVersion} listening on ${listenUrl.slice(0, -1)}`,
  )
  onEvent("http-ready")

  if (
    shouldOpenBrowser({
      noOpenFlag: hasNoOpenFlag(argv),
      env: {
        NO_BROWSER: environment.NO_BROWSER,
        PORT: String(listenPort),
      },
    })
  ) {
    // Wildcard → loopback; concrete bind host → that address (never 0.0.0.0).
    openBrowser(resolveBrowserOpenUrl(listenPort, hostname))
    onEvent("browser-open")
  }

  /**
   * Await disposal for process-exit paths without leaving rejections unhandled.
   * Exit runs only after cleanup has settled (success or failure).
   */
  const disposeThenExit = (exit: () => void) => {
    void dispose()
      .catch((disposalError: unknown) => {
        logError(
          `Production lifecycle disposal failed: ${
            disposalError instanceof Error
              ? disposalError.message
              : String(disposalError)
          }`,
        )
      })
      .finally(exit)
  }

  if (ownedChild !== undefined) {
    ownedChild.on("exit", (code, signal) => {
      if (shuttingDown) return
      childFailed = true
      onEvent("child-failed")
      logError(
        `Keymaxxer Sidecar exited while the Harness was running (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""})`,
      )
      disposeThenExit(() => {
        exitProcess(1)
      })
    })
  }

  removeSignalHandlers = installSignalHandlers((signal) => {
    disposeThenExit(() => {
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
