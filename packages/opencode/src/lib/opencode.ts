import { Deferred, Duration, Effect, Layer, Ref, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  AGENT_BACKEND_IDS,
  AgentBackend,
  AgentBackendConfigError,
  type AgentBackendError,
  AgentBackendMalformedOutputError,
  AgentBackendTimeoutError,
  type AgentTurnResult,
  type ContinueTurnInput,
  DEFAULT_STARTUP_TIMEOUT,
  type InspectInput,
  PROMPT_ARGV_BYTE_LIMIT,
  type PendingImplementStop,
  type StartTurnInput,
  retrySilentKnownSessionStartup,
  runCliCapture,
  runCliTurn,
  stopRecordedInvocation,
} from "@ready-for-agent/agent-backend"
import {
  buildCommandApiArgs,
  buildCommandApiRequest,
  buildCreateSessionApiArgs,
  buildModelCatalogApiArgs,
  buildRunArgs,
  buildSessionExportArgs,
  buildSessionInterruptApiArgs,
  buildSessionWaitApiArgs,
  buildSwitchModelApiArgs,
  commandBodyExceedsArgvLimit,
  shouldUsePromptStdin,
  withOpenCodeServer,
} from "./build-args.js"
import { makeOpencodeEnvironment } from "./environment.js"
import type { OpencodeConfigError } from "./errors.js"
import {
  identifyImplementTarget,
  jsonRecord,
  localImplementServerExited,
  verifyImplementIdle,
} from "./implement-stop-target.js"
import {
  type OpencodePathEnv,
  resolveOpencodeDbPathFromRules,
} from "./opencode-db-path.js"
import { readRegisteredEndpoint } from "./opencode-v2-client.js"
import type { OpencodeV2Reader } from "./opencode-v2-read.js"
import { startTemporaryOpenCodeServer } from "./owned-server.js"
import { parseAssistantTextFromLine } from "./parse-assistant-text.js"
import { parseCommandTaskResultFromLine } from "./parse-command-task-result.js"
import {
  parseCommandTranscript,
  parseCreatedSessionId,
  parsePromptReply,
} from "./parse-command-transcript.js"
import {
  parseErrorClassificationFromLine,
  parseProviderRetryAtFromLine,
  parseV2ErrorMessageFromLine,
} from "./parse-error-classification.js"
import {
  OPENCODE_CATALOG_EMPTY_MESSAGE,
  OPENCODE_CATALOG_MALFORMED_MESSAGE,
  parseOpencodeModelCatalog,
} from "./parse-model-catalog.js"
import { parseSessionIdFromLine } from "./parse-session-id.js"
import { runStoppablePlainPrompt } from "./plain-prompt-stop.js"
import { observeOpencodeSessionModel } from "./session-model.js"
import {
  type OpencodeStartupProbe,
  connectStartupReader,
  makeOpencodeStartupProbe,
  observeOpencodeStartupActivity,
} from "./startup-activity.js"
import type { OpencodeLayerOptions } from "./types.js"

const DEFAULT_TIMEOUT = Duration.minutes(30)
const DEFAULT_BINARY = "opencode"
const CATALOG_SETTLE_TIMEOUT_MS = 5_000
const CATALOG_SETTLE_POLL_MS = 150

const OPENCODE_V2_REQUIRED_MESSAGE =
  "OpenCode 2 is required. This CLI is not OpenCode 2. Install OpenCode 2, then Recheck Agent Backend."

const isOpenCodeV1Version = (text: string): boolean =>
  /(?:^|\s)v?1\.\d+\.\d+/.test(text) && !/(?:^|\s)v?2\.\d+\.\d+/.test(text)

const OPENCODE_BACKEND = {
  id: AGENT_BACKEND_IDS.opencode,
  label: "OpenCode",
} as const

const submitOwnedOpenCodeCommand = (
  input: Parameters<typeof buildCommandApiRequest>[0] & {
    readonly server: NonNullable<OpencodeLayerOptions["dedicatedServer"]>
    readonly timeout: Duration.Input
  },
) => {
  const { path, body, directory } = buildCommandApiRequest(input)
  const unconfirmed = `OpenCode did not confirm the Agent Command for session ${input.sessionId}. It may have been accepted; the harness did not resend it.`
  const uncertain = () => new AgentBackendConfigError({ message: unconfirmed })

  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(new URL(path, input.server.baseUrl), {
        method: "POST",
        headers: {
          ...input.server.headers,
          "content-type": "application/json",
          "x-opencode-directory": encodeURIComponent(directory),
        },
        body,
        signal,
        // The known loopback endpoint is the only recipient of this POST.
        proxy: false,
        redirect: "error",
        keepalive: false,
      })
      await response.arrayBuffer()
      return response.status
    },
    // Client failures may include the payload or credentials. Do not log them
    // or retry: OpenCode may already have applied the POST.
    catch: uncertain,
  }).pipe(
    Effect.flatMap((status) =>
      status === 204
        ? Effect.void
        : Effect.fail(
            status >= 400 && status < 500
              ? new AgentBackendConfigError({
                  message: `OpenCode rejected the Agent Command for session ${input.sessionId} (HTTP ${status}).`,
                })
              : uncertain(),
          ),
    ),
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () =>
        new AgentBackendTimeoutError({
          cwd: directory,
          timeoutMs: Duration.toMillis(input.timeout),
          sessionId: input.sessionId,
          message: unconfirmed,
        }),
    }),
  )
}

export type OpencodeLayerError = OpencodeConfigError

/**
 * OpenCode adapter implementing the backend-neutral AgentBackend contract.
 */
export const Opencode = {
  layer: (options: OpencodeLayerOptions) =>
    Layer.effect(
      AgentBackend,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const binary = options.binary ?? DEFAULT_BINARY
        const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
        const environment = yield* makeOpencodeEnvironment({
          keymaxxerMcpUrl: options.keymaxxerMcpUrl,
          environment: options.environment,
        }).pipe(
          Effect.mapError(
            (error) =>
              new AgentBackendConfigError({
                message: error.message,
                ...(error.cause !== undefined ? { cause: error.cause } : {}),
              }),
          ),
        )
        const pathEnv = {
          HOME: environment["HOME"],
          XDG_DATA_HOME: environment["XDG_DATA_HOME"],
          OPENCODE_DB: environment["OPENCODE_DB"],
          OPENCODE_DISABLE_CHANNEL_DB:
            environment["OPENCODE_DISABLE_CHANNEL_DB"],
        } satisfies OpencodePathEnv
        const assertOpenCodeV2 = (input: {
          readonly cwd: string
          readonly timeout: Duration.Input
        }) =>
          runCliCapture({
            spawner,
            backend: OPENCODE_BACKEND,
            binary,
            args: ["--version"],
            cwd: input.cwd,
            env: turnEnvironment(input.cwd),
            timeout: "1 second",
            allowNonZeroExit: true,
          }).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.flatMap((version) => {
              if (version === undefined || version.exitCode !== 0) {
                return Effect.void
              }
              const text = `${version.stdout}\n${version.stderr}`
              return isOpenCodeV1Version(text)
                ? Effect.fail(
                    new AgentBackendConfigError({
                      message: OPENCODE_V2_REQUIRED_MESSAGE,
                    }),
                  )
                : Effect.void
            }),
          )

        const dedicated = options.dedicatedServer
        const blockedReason = options.openCodeBlockedReason
        const explicitServerUrl = dedicated?.baseUrl ?? options.server?.baseUrl
        const serviceArgs = (
          args: ReadonlyArray<string>,
        ): ReadonlyArray<string> => withOpenCodeServer(args, explicitServerUrl)
        const readerServer =
          dedicated === undefined
            ? options.server
            : {
                baseUrl: dedicated.baseUrl,
                headers: dedicated.headers,
              }

        const requireOwnedServer = (): Effect.Effect<
          void,
          AgentBackendConfigError
        > => {
          if (blockedReason !== undefined && blockedReason.length > 0) {
            return Effect.fail(
              new AgentBackendConfigError({ message: blockedReason }),
            )
          }
          if (dedicated === undefined) return Effect.void
          const unavailable = dedicated.assertAvailable()
          if (unavailable === undefined) return Effect.void
          return Effect.fail(
            new AgentBackendConfigError({ message: unavailable }),
          )
        }

        const inspect = Effect.fn("Opencode.inspect")(function* (
          input: InspectInput,
        ) {
          const timeout = input.timeout ?? defaultTimeout
          const timeoutMs = Duration.toMillis(Duration.fromInputUnsafe(timeout))
          const settleWindowMs = Math.min(CATALOG_SETTLE_TIMEOUT_MS, timeoutMs)
          yield* requireOwnedServer()
          yield* assertOpenCodeV2({ cwd: input.cwd, timeout })
          const env = turnEnvironment(input.cwd)

          const pollCatalogOnServer = (
            serverUrl: string,
            serverEnv: Record<string, string>,
            deadlineMs: number,
          ) =>
            Effect.gen(function* () {
              const args = withOpenCodeServer(
                buildModelCatalogApiArgs({ directory: input.cwd }),
                serverUrl,
              )
              for (;;) {
                const remainingMs = Math.max(1_000, deadlineMs - Date.now())
                const attemptTimeout = Duration.millis(
                  Math.min(timeoutMs, remainingMs),
                )
                const result = yield* runCliCapture({
                  spawner,
                  backend: OPENCODE_BACKEND,
                  binary,
                  args,
                  cwd: input.cwd,
                  env: serverEnv,
                  timeout: attemptTimeout,
                })
                const parsed = parseOpencodeModelCatalog(result.stdout)
                if (parsed.kind !== "empty" || Date.now() >= deadlineMs) {
                  return parsed
                }
                yield* Effect.sleep(Duration.millis(CATALOG_SETTLE_POLL_MS))
              }
            })

          // Disabled Keymaxxer starts with `--standalone`, which pins the
          // catalog to this process cwd and returns immediately on OpenCode
          // 2.0.32. On OpenCode 2.4.x, `GET /api/model` may precede initial
          // plugin settlement and return `data: []` before the standalone
          // server exits; in that case, spin up a temporary private `serve`
          // process and poll until the catalog settles. A harness-owned server
          // is queried with `--server` and the worktree directory header, and
          // also polls if a newly-booted location has not settled yet.
          let parsed =
            dedicated === undefined
              ? parseOpencodeModelCatalog(
                  (yield* runCliCapture({
                    spawner,
                    backend: OPENCODE_BACKEND,
                    binary,
                    args: ["api", "--standalone", "get", "/api/model"],
                    cwd: input.cwd,
                    env,
                    timeout,
                  })).stdout,
                )
              : yield* pollCatalogOnServer(
                  dedicated.baseUrl,
                  env,
                  Date.now() + settleWindowMs,
                )

          if (dedicated === undefined && parsed.kind === "empty") {
            const settled = yield* Effect.scoped(
              Effect.gen(function* () {
                const tempServer = yield* Effect.acquireRelease(
                  Effect.tryPromise(() =>
                    startTemporaryOpenCodeServer({
                      binary,
                      cwd: input.cwd,
                      env,
                      readyTimeoutMs: settleWindowMs,
                    }),
                  ),
                  (server) =>
                    Effect.promise(() => server.dispose()).pipe(Effect.ignore),
                )
                return yield* pollCatalogOnServer(
                  tempServer.baseUrl,
                  { ...env, OPENCODE_PASSWORD: tempServer.password },
                  Date.now() + settleWindowMs,
                )
              }),
            ).pipe(
              Effect.tapError((error) =>
                Effect.logDebug(
                  `Temporary OpenCode server fallback failed during inspect: ${String(error)}`,
                ),
              ),
              Effect.orElseSucceed(() => undefined),
            )
            if (settled !== undefined) {
              parsed = settled
            }
          }

          if (parsed.kind === "malformed") {
            return yield* new AgentBackendConfigError({
              message: OPENCODE_CATALOG_MALFORMED_MESSAGE(parsed.reason),
            })
          }
          if (parsed.kind === "empty") {
            return yield* new AgentBackendConfigError({
              message: OPENCODE_CATALOG_EMPTY_MESSAGE,
            })
          }

          return {
            backend: OPENCODE_BACKEND,
            models: parsed.models,
          }
        })

        // Cache a discovered reader so startup polls do not rediscover on every
        // tick. Misses retry with backoff so a service that is still starting
        // can disarm the window later, without hammering discovery.
        let cachedStartupReader: OpencodeV2Reader | undefined
        let lastStartupReaderAttemptMs = 0
        const STARTUP_READER_RETRY_MS = 2_000

        const resolveStartupReader =
          async (): Promise<OpencodeV2Reader | null> => {
            if (cachedStartupReader !== undefined) {
              return cachedStartupReader
            }
            const now = Date.now()
            if (
              lastStartupReaderAttemptMs > 0 &&
              now - lastStartupReaderAttemptMs < STARTUP_READER_RETRY_MS
            ) {
              return null
            }
            lastStartupReaderAttemptMs = now
            const reader = await connectStartupReader({
              ...(readerServer === undefined ? {} : { server: readerServer }),
            })
            if (reader !== null) {
              cachedStartupReader = reader
            }
            return reader
          }

        const startupProbe: OpencodeStartupProbe =
          options.startupActivityProbe ??
          makeOpencodeStartupProbe({
            ...(readerServer === undefined ? {} : { server: readerServer }),
            resolveReader: resolveStartupReader,
          })

        const turnEnvironment = (cwd: string): Record<string, string> => ({
          ...environment,
          // V2 `opencode run` resolves the project from PWD before process cwd.
          // Inherited PWD is the Harness directory, so each turn must pin it.
          PWD: cwd,
          // CLI `--server` auth. Memory-only; not written to config files.
          ...(dedicated === undefined
            ? {}
            : { OPENCODE_PASSWORD: dedicated.password }),
        })

        const captureAt =
          (
            cwd: string,
            env: Record<string, string>,
            serverUrl: string | undefined,
            timeout: Duration.Input = "3 seconds",
          ) =>
          (args: ReadonlyArray<string>) =>
            runCliCapture({
              spawner,
              backend: OPENCODE_BACKEND,
              binary,
              args: withOpenCodeServer(args, serverUrl),
              cwd,
              env,
              timeout,
            })

        const implementConnection = (cwd: string, startShared: boolean) =>
          Effect.gen(function* () {
            yield* requireOwnedServer()
            const env = turnEnvironment(cwd)
            if (explicitServerUrl !== undefined) {
              return {
                kind: "attached" as const,
                url: explicitServerUrl,
                env,
                local: dedicated !== undefined,
              }
            }
            // Use normal CLI discovery/startup. Then pin this invocation and
            // all its stop calls to the same registered server.
            const bootstrap = startShared
              ? yield* captureAt(
                  cwd,
                  env,
                  undefined,
                  options.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT,
                )(["api", "get", "/api/info"])
              : undefined
            const registered = readRegisteredEndpoint(env)
            if (registered === null) {
              const pid =
                bootstrap === undefined
                  ? undefined
                  : jsonRecord(bootstrap.stdout)?.pid
              if (typeof pid === "number" && localImplementServerExited(pid)) {
                // With service discovery disabled, a successful API call
                // used its own private server. Keep the turn private too:
                // its server is inside the verified CLI invocation boundary.
                return { kind: "standalone" as const, env }
              }
              return yield* new AgentBackendConfigError({
                message:
                  "The original OpenCode shared server is not registered.",
              })
            }
            return {
              kind: "attached" as const,
              url: registered.url,
              env:
                registered.auth === undefined
                  ? env
                  : { ...env, OPENCODE_PASSWORD: registered.auth.password },
              local: true,
            }
          })

        const verifyImplementStopped = (
          input: PendingImplementStop & { readonly cwd: string },
        ) =>
          Effect.gen(function* () {
            if ("invocation" in input) {
              return yield* stopRecordedInvocation(input.invocation)
            }
            if (localImplementServerExited(input.localPid)) return
            const connection = yield* implementConnection(input.cwd, false)
            if (connection.kind !== "attached") {
              return yield* new AgentBackendConfigError({
                message: "The original OpenCode server is not available.",
              })
            }
            const capture = captureAt(input.cwd, connection.env, connection.url)
            const current = yield* identifyImplementTarget({
              sessionId: input.sessionId,
              serverUrl: connection.url,
              local: connection.local,
              capture,
              ownedServer: dedicated,
            })
            if (current.serverKey !== input.serverKey) {
              return yield* new AgentBackendConfigError({
                message: `OpenCode session ${input.sessionId} belongs to a different server process.`,
              })
            }
            yield* verifyImplementIdle(input.sessionId, capture)
          })

        const runTurn = (
          input: StartTurnInput & { readonly sessionId?: string },
        ): Effect.Effect<AgentTurnResult, AgentBackendError> => {
          const unavailable =
            blockedReason !== undefined && blockedReason.length > 0
              ? blockedReason
              : dedicated?.assertAvailable()
          if (unavailable !== undefined) {
            return Effect.fail(
              new AgentBackendConfigError({ message: unavailable }),
            )
          }
          const command = input.command
          const scopedReply =
            command === undefined && input.replyToPromptOnly === true
          // The CLI generates its own user message ID, which it doesn't print.
          // A unique reference in the submitted user message makes the
          // transcript lookup unambiguous, including on identical retries.
          const prompt = scopedReply
            ? `[Ready for Agent turn ${crypto.randomUUID()}]\n\n${input.prompt.trim()}`
            : input.prompt
          const promptOnStdin =
            command === undefined && shouldUsePromptStdin({ prompt })
          const env = turnEnvironment(input.cwd)
          const timeout = input.timeout ?? defaultTimeout
          if (
            command !== undefined &&
            dedicated === undefined &&
            commandBodyExceedsArgvLimit({
              command,
              prompt,
            })
          ) {
            return Effect.fail(
              new AgentBackendConfigError({
                message: `OpenCode cannot start this Agent Command. This connection submits the command body as --data, and this prompt exceeds the ${PROMPT_ARGV_BYTE_LIMIT} byte limit. The turn was not started.`,
              }),
            )
          }
          // Snapshot just before spawn so only post-spawn task/child activity
          // disarms the startup window (not historical review attempts).
          const startedAfterMs = Date.now()
          const knownSessionId = input.sessionId

          const invalidModel = () =>
            new AgentBackendConfigError({
              message: `OpenCode model reference is invalid: ${input.model}`,
            })

          const interruptSession = (sessionId: string) =>
            runCliCapture({
              spawner,
              backend: OPENCODE_BACKEND,
              binary,
              args: serviceArgs(buildSessionInterruptApiArgs(sessionId)),
              cwd: input.cwd,
              env,
              timeout,
              allowNonZeroExit: true,
            }).pipe(Effect.ignore)

          const stopSessionOnAbort = <A, E, R>(
            sessionId: string,
            effect: Effect.Effect<A, E, R>,
          ) =>
            effect.pipe(
              Effect.onInterrupt(() => interruptSession(sessionId)),
              Effect.tapError((error) =>
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                (error._tag === "AgentBackendTimeoutError" ||
                  error._tag === "AgentBackendStartupTimeoutError")
                  ? interruptSession(sessionId)
                  : Effect.void,
              ),
            )

          const ensureCommandSession = (): Effect.Effect<
            string,
            AgentBackendError
          > => {
            if (knownSessionId !== undefined) {
              const switchArgs = buildSwitchModelApiArgs({
                sessionId: knownSessionId,
                model: input.model,
                thinkingLevel: input.thinkingLevel,
                directory: input.cwd,
              })
              if (switchArgs === undefined) {
                return Effect.fail(invalidModel())
              }
              return runCliCapture({
                spawner,
                backend: OPENCODE_BACKEND,
                binary,
                args: serviceArgs(switchArgs),
                cwd: input.cwd,
                env,
                timeout,
              }).pipe(Effect.as(knownSessionId))
            }
            const createArgs = buildCreateSessionApiArgs({
              model: input.model,
              thinkingLevel: input.thinkingLevel,
              directory: input.cwd,
            })
            if (createArgs === undefined) {
              return Effect.fail(invalidModel())
            }
            return runCliCapture({
              spawner,
              backend: OPENCODE_BACKEND,
              binary,
              args: serviceArgs(createArgs),
              cwd: input.cwd,
              env,
              timeout,
            }).pipe(
              Effect.flatMap((created) => {
                const sessionId = parseCreatedSessionId(created.stdout)
                if (sessionId === undefined) {
                  return Effect.fail(
                    new AgentBackendMalformedOutputError({
                      cwd: input.cwd,
                      byteLength: Buffer.byteLength(created.stdout, "utf8"),
                    }),
                  )
                }
                return Effect.succeed(sessionId)
              }),
            )
          }

          const collectCommandResult = (
            sessionId: string,
            commandName: string,
          ): Effect.Effect<string, AgentBackendError> =>
            stopSessionOnAbort(
              sessionId,
              runCliCapture({
                spawner,
                backend: OPENCODE_BACKEND,
                binary,
                args: serviceArgs(buildSessionWaitApiArgs(sessionId)),
                cwd: input.cwd,
                env,
                timeout,
              }),
            ).pipe(
              Effect.andThen(
                runCliCapture({
                  spawner,
                  backend: OPENCODE_BACKEND,
                  binary,
                  args: serviceArgs(buildSessionExportArgs(sessionId)),
                  cwd: input.cwd,
                  env,
                  timeout,
                }),
              ),
              Effect.flatMap((exported) => {
                const assistantText = parseCommandTranscript({
                  transcript: exported.stdout,
                  command: commandName,
                  startedAfterMs,
                })
                if (assistantText === undefined) {
                  return Effect.fail(
                    new AgentBackendMalformedOutputError({
                      cwd: input.cwd,
                      byteLength: Buffer.byteLength(exported.stdout, "utf8"),
                    }),
                  )
                }
                return Effect.succeed(assistantText)
              }),
            )

          return Effect.scoped(
            Effect.gen(function* () {
              const sessionReady = yield* Deferred.make<string>()
              const sessionOffered = yield* Ref.make(false)
              const offerSessionId = (sessionId: string) =>
                Ref.getAndSet(sessionOffered, true).pipe(
                  Effect.flatMap((already) =>
                    already
                      ? Effect.void
                      : Deferred.succeed(sessionReady, sessionId).pipe(
                          Effect.asVoid,
                        ),
                  ),
                )
              if (knownSessionId !== undefined) {
                yield* offerSessionId(knownSessionId)
              }

              const track =
                command === undefined ? input.trackImplementStop : undefined
              const connection =
                track === undefined
                  ? undefined
                  : yield* implementConnection(input.cwd, true)
              // `run --session` creates the session when absent. Reserve its
              // ID here rather than trying to find it in a shared server.
              let turnSessionId =
                knownSessionId ??
                (track === undefined ? undefined : `ses_${crypto.randomUUID()}`)
              const turnEnv = connection?.env ?? env
              const turnServerUrl =
                connection?.kind === "attached"
                  ? connection.url
                  : explicitServerUrl
              let turnArgs: ReadonlyArray<string> =
                command === undefined
                  ? withOpenCodeServer(
                      buildRunArgs({
                        prompt,
                        model: input.model,
                        thinkingLevel: input.thinkingLevel,
                        sessionId: turnSessionId,
                      }),
                      turnServerUrl,
                    )
                  : []
              if (connection?.kind === "standalone") {
                turnArgs = ["run", "--standalone", ...turnArgs.slice(1)]
              }
              const turnStdin: "ignore" | Stream.Stream<Uint8Array, never> =
                promptOnStdin
                  ? Stream.fromIterable([new TextEncoder().encode(prompt)])
                  : "ignore"
              if (command !== undefined) {
                turnSessionId = yield* ensureCommandSession()
                if (knownSessionId === undefined) {
                  yield* offerSessionId(turnSessionId)
                  if (input.onSessionId !== undefined) {
                    // Observer failures must not fail the turn.
                    yield* input.onSessionId(turnSessionId).pipe(Effect.ignore)
                  }
                }
              }

              yield* Deferred.await(sessionReady).pipe(
                Effect.flatMap((sessionId) =>
                  observeOpencodeSessionModel({
                    sessionId,
                    model: input.model,
                    thinkingLevel: input.thinkingLevel,
                    // Session-model reassertion still writes the on-disk record.
                    // It does not call `opencode db path`. Startup activity uses
                    // the V2 API instead of this path.
                    resolveDbPath: () => {
                      if (options.startupActivityDbPath !== undefined) {
                        return options.startupActivityDbPath
                      }
                      return resolveOpencodeDbPathFromRules({
                        env: pathEnv,
                      })
                    },
                  }),
                ),
                Effect.forkScoped,
              )

              if (command !== undefined && turnSessionId !== undefined) {
                const request = {
                  sessionId: turnSessionId,
                  command,
                  prompt,
                  directory: input.cwd,
                }
                if (dedicated !== undefined) {
                  yield* stopSessionOnAbort(
                    turnSessionId,
                    submitOwnedOpenCodeCommand({
                      ...request,
                      server: dedicated,
                      timeout,
                    }),
                  )
                  const assistantText = yield* collectCommandResult(
                    turnSessionId,
                    command,
                  )
                  return { sessionId: turnSessionId, assistantText }
                }
                turnArgs = serviceArgs(buildCommandApiArgs(request))
              }

              const privateSessionId = turnSessionId
              const turn = runCliTurn({
                spawner,
                backend: OPENCODE_BACKEND,
                binary,
                args: turnArgs,
                cwd: input.cwd,
                env: turnEnv,
                timeout,
                knownSessionId: turnSessionId,
                onSessionId: (sessionId) =>
                  offerSessionId(sessionId).pipe(
                    Effect.andThen(
                      input.onSessionId === undefined
                        ? Effect.void
                        : input.onSessionId(sessionId),
                    ),
                  ),
                ...(track !== undefined &&
                connection?.kind === "standalone" &&
                privateSessionId !== undefined
                  ? {
                      trackInvocation: {
                        started: (invocation) =>
                          track.started({
                            sessionId: privateSessionId,
                            invocation,
                          }),
                        stopped: (invocation) =>
                          track.stopped({
                            sessionId: privateSessionId,
                            invocation,
                          }),
                      },
                    }
                  : {}),
                ...(options.startupTimeout !== undefined
                  ? { startupTimeout: options.startupTimeout }
                  : {}),
                // Always attach when the Session is known: discovery may miss
                // on the first poll and succeed later.
                ...(knownSessionId !== undefined
                  ? {
                      observeStartup: observeOpencodeStartupActivity({
                        sessionId: knownSessionId,
                        startedAfterMs,
                        probe: startupProbe,
                      }),
                    }
                  : {}),
                observerLabel: "OpenCode",
                parseLine: (line) => {
                  const sessionId = parseSessionIdFromLine(line)
                  const errorClassification =
                    parseErrorClassificationFromLine(line)
                  const errorMessage = parseV2ErrorMessageFromLine(line)
                  const retryAt = parseProviderRetryAtFromLine(line)
                  const parsed = {
                    ...(sessionId !== undefined ? { sessionId } : {}),
                    ...(errorClassification !== undefined
                      ? { errorClassification }
                      : {}),
                    ...(errorMessage !== undefined ? { errorMessage } : {}),
                    ...(retryAt !== undefined ? { retryAt } : {}),
                  }
                  if (command !== undefined) {
                    const commandText = parseCommandTaskResultFromLine(
                      line,
                      command,
                    )
                    if (commandText !== undefined) {
                      return {
                        ...parsed,
                        finalizeText: commandText,
                      }
                    }
                  }
                  return {
                    ...parsed,
                    ...(scopedReply
                      ? {}
                      : { text: parseAssistantTextFromLine(line) }),
                  }
                },
                stdin: turnStdin,
              })
              const tracked = (
                sessionId: string,
                targetConnection: Extract<
                  typeof connection,
                  { kind: "attached" }
                >,
                tracker: NonNullable<typeof track>,
              ) =>
                Effect.gen(function* () {
                  const capture = captureAt(
                    input.cwd,
                    targetConnection.env,
                    targetConnection.url,
                  )
                  const target = yield* identifyImplementTarget({
                    sessionId,
                    serverUrl: targetConnection.url,
                    local: targetConnection.local,
                    capture,
                    ownedServer: dedicated,
                  })
                  return yield* runStoppablePlainPrompt({
                    target,
                    prompt,
                    resumed: knownSessionId !== undefined,
                    run: turn,
                    track: tracker,
                    capture,
                    verifyIdle: verifyImplementStopped({
                      ...target,
                      cwd: input.cwd,
                    }),
                  })
                })
              const streamed = yield* turnSessionId === undefined
                ? turn
                : command !== undefined
                  ? stopSessionOnAbort(turnSessionId, turn)
                  : track === undefined || connection?.kind !== "attached"
                    ? turn
                    : tracked(turnSessionId, connection, track)
              if (scopedReply) {
                const exported = yield* runCliCapture({
                  spawner,
                  backend: OPENCODE_BACKEND,
                  binary,
                  args: withOpenCodeServer(
                    buildSessionExportArgs(streamed.sessionId),
                    turnServerUrl,
                  ),
                  cwd: input.cwd,
                  env: turnEnv,
                  timeout,
                })
                const reply = parsePromptReply({
                  transcript: exported.stdout,
                  sessionId: streamed.sessionId,
                  submittedPrompt: prompt,
                })
                if (reply === undefined) {
                  return yield* new AgentBackendMalformedOutputError({
                    cwd: input.cwd,
                    byteLength: Buffer.byteLength(exported.stdout, "utf8"),
                  })
                }
                return { sessionId: streamed.sessionId, ...reply }
              }
              if (
                command !== undefined &&
                streamed.assistantText.length === 0
              ) {
                const assistantText = yield* collectCommandResult(
                  streamed.sessionId,
                  command,
                )
                return {
                  sessionId: streamed.sessionId,
                  assistantText,
                }
              }
              return streamed
            }),
          )
        }

        return AgentBackend.of({
          inspect,
          verifyImplementStopped,
          startTurn: Effect.fn("Opencode.startTurn")((input: StartTurnInput) =>
            runTurn(input),
          ),
          continueTurn: Effect.fn("Opencode.continueTurn")(
            (input: ContinueTurnInput) =>
              dedicated !== undefined && input.command !== undefined
                ? runTurn(input)
                : retrySilentKnownSessionStartup(() => runTurn(input), {
                    sessionId: input.sessionId,
                    model: input.model,
                    observerLabel: "OpenCode",
                  }),
          ),
        })
      }),
    ),

  /** Test/integration helper with Keymaxxer enabled by default. */
  layerForTests: (keymaxxerMcpUrl = "http://127.0.0.1:6057/test-cap/mcp") =>
    Opencode.layer({ keymaxxerMcpUrl }),
}
