import { Deferred, Duration, Effect, Layer, Ref, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  AGENT_BACKEND_IDS,
  AgentBackend,
  AgentBackendConfigError,
  type AgentBackendError,
  AgentBackendMalformedOutputError,
  type ContinueTurnInput,
  type InspectInput,
  PROMPT_ARGV_BYTE_LIMIT,
  type StartTurnInput,
  retrySilentKnownSessionStartup,
  runCliCapture,
  runCliTurn,
} from "@ready-for-agent/agent-backend"
import {
  buildCommandApiArgs,
  buildCreateSessionApiArgs,
  buildRunArgs,
  buildSessionExportArgs,
  buildSessionInterruptApiArgs,
  buildSessionWaitApiArgs,
  buildSwitchModelApiArgs,
  commandBodyExceedsArgvLimit,
  shouldUsePromptStdin,
} from "./build-args.js"
import { makeOpencodeEnvironment } from "./environment.js"
import type { OpencodeConfigError } from "./errors.js"
import {
  type OpencodePathEnv,
  resolveOpencodeDbPath,
  resolveOpencodeDbPathFromRules,
} from "./opencode-db-path.js"
import { parseAssistantTextFromLine } from "./parse-assistant-text.js"
import { parseCommandTaskResultFromLine } from "./parse-command-task-result.js"
import {
  parseCommandTranscript,
  parseCreatedSessionId,
} from "./parse-command-transcript.js"
import {
  parseErrorClassificationFromLine,
  parseProviderRetryAtFromLine,
} from "./parse-error-classification.js"
import {
  OPENCODE_CATALOG_EMPTY_MESSAGE,
  OPENCODE_CATALOG_MALFORMED_MESSAGE,
  parseOpencodeModelCatalog,
} from "./parse-model-catalog.js"
import { parseSessionIdFromLine } from "./parse-session-id.js"
import { observeOpencodeSessionModel } from "./session-model.js"
import { observeOpencodeStartupActivity } from "./startup-activity.js"
import type { OpencodeLayerOptions } from "./types.js"

const DEFAULT_TIMEOUT = Duration.minutes(30)
const DEFAULT_BINARY = "opencode"

const OPENCODE_V2_REQUIRED_MESSAGE =
  "OpenCode 2 is required. This CLI is not OpenCode 2. Install OpenCode 2, then Recheck Agent Backend."

const isOpenCodeV1Version = (text: string): boolean =>
  /(?:^|\s)v?1\.\d+\.\d+/.test(text) && !/(?:^|\s)v?2\.\d+\.\d+/.test(text)

const OPENCODE_BACKEND = {
  id: AGENT_BACKEND_IDS.opencode,
  label: "OpenCode",
} as const

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

        const inspect = Effect.fn("Opencode.inspect")(function* (
          input: InspectInput,
        ) {
          const timeout = input.timeout ?? defaultTimeout
          yield* assertOpenCodeV2({ cwd: input.cwd, timeout })
          // `--standalone` pins the catalog to this process cwd. Without it,
          // V2 `api get` reads the background server's location and ignores cwd.
          const result = yield* runCliCapture({
            spawner,
            backend: OPENCODE_BACKEND,
            binary,
            args: ["api", "--standalone", "get", "/api/model"],
            cwd: input.cwd,
            env: turnEnvironment(input.cwd),
            timeout,
          })

          const parsed = parseOpencodeModelCatalog(result.stdout)
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

        // Cache a successful DB path for the adapter lifetime so session-bearing
        // turns do not re-spawn `opencode db path` after the first hit. Misses
        // are retried with backoff so a transient CLI failure does not drop the
        // #852 probe, without spawnSync-thrashing every 100ms poll on a permanent
        // miss (CLI lookup can block up to ~2s).
        let cachedStartupActivityDbPath: string | undefined =
          options.startupActivityDbPath
        let lastStartupDbPathResolveAttemptMs = 0
        const STARTUP_DB_PATH_RETRY_MS = 2_000

        const resolveStartupActivityDbPath = (): string | null => {
          if (options.startupActivityDbPath !== undefined) {
            return options.startupActivityDbPath
          }
          if (cachedStartupActivityDbPath !== undefined) {
            return cachedStartupActivityDbPath
          }
          const now = Date.now()
          if (
            lastStartupDbPathResolveAttemptMs > 0 &&
            now - lastStartupDbPathResolveAttemptMs < STARTUP_DB_PATH_RETRY_MS
          ) {
            return null
          }
          lastStartupDbPathResolveAttemptMs = now
          const resolved = resolveOpencodeDbPath({
            binary,
            env: pathEnv,
          })
          if (resolved !== null) {
            cachedStartupActivityDbPath = resolved
          }
          return resolved
        }

        const turnEnvironment = (cwd: string): Record<string, string> => ({
          ...environment,
          // V2 `opencode run` resolves the project from PWD before process cwd.
          // Inherited PWD is the Harness directory, so each turn must pin it.
          PWD: cwd,
        })

        const runTurn = (input: {
          readonly prompt: string
          readonly cwd: string
          readonly model: string
          readonly thinkingLevel: string | null
          readonly sessionId?: string
          readonly command?: string
          readonly timeout?: Duration.Input
          readonly onSessionId?: StartTurnInput["onSessionId"]
        }): Effect.Effect<
          { readonly sessionId: string; readonly assistantText: string },
          AgentBackendError
        > => {
          const promptOnStdin =
            input.command === undefined &&
            shouldUsePromptStdin({ prompt: input.prompt })
          const args =
            input.command === undefined
              ? buildRunArgs({
                  prompt: input.prompt,
                  model: input.model,
                  thinkingLevel: input.thinkingLevel,
                  sessionId: input.sessionId,
                })
              : []
          const command = input.command
          const env = turnEnvironment(input.cwd)
          const timeout = input.timeout ?? defaultTimeout
          if (
            command !== undefined &&
            commandBodyExceedsArgvLimit({
              command,
              prompt: input.prompt,
            })
          ) {
            return Effect.fail(
              new AgentBackendConfigError({
                message: `OpenCode cannot start this Agent Command. OpenCode v2 only accepts the command body as --data, and this prompt exceeds the ${PROMPT_ARGV_BYTE_LIMIT} byte limit. The turn was not started.`,
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
              args: buildSessionInterruptApiArgs(sessionId),
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
                args: switchArgs,
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
              args: createArgs,
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
                args: buildSessionWaitApiArgs(sessionId),
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
                  args: buildSessionExportArgs(sessionId),
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

              let turnSessionId = knownSessionId
              let turnArgs: ReadonlyArray<string> = args
              const turnStdin: "ignore" | Stream.Stream<Uint8Array, never> =
                promptOnStdin
                  ? Stream.fromIterable([
                      new TextEncoder().encode(input.prompt),
                    ])
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
                turnArgs = buildCommandApiArgs({
                  sessionId: turnSessionId,
                  command,
                  prompt: input.prompt,
                  directory: input.cwd,
                })
              }

              yield* Deferred.await(sessionReady).pipe(
                Effect.flatMap((sessionId) =>
                  observeOpencodeSessionModel({
                    sessionId,
                    model: input.model,
                    thinkingLevel: input.thinkingLevel,
                    // Never spawn the turn binary as `opencode db path`: a
                    // fake/test binary (or a hung CLI) would block spawnSync.
                    // Prefer the startup-probe cache; on first Build that
                    // probe never runs, so fall back to OpenCode's path rules.
                    resolveDbPath: () => {
                      if (options.startupActivityDbPath !== undefined) {
                        return options.startupActivityDbPath
                      }
                      if (cachedStartupActivityDbPath !== undefined) {
                        return cachedStartupActivityDbPath
                      }
                      const fromRules = resolveOpencodeDbPathFromRules({
                        env: pathEnv,
                      })
                      cachedStartupActivityDbPath = fromRules
                      return fromRules
                    },
                  }),
                ),
                Effect.forkScoped,
              )

              const turn = runCliTurn({
                spawner,
                backend: OPENCODE_BACKEND,
                binary,
                args: turnArgs,
                cwd: input.cwd,
                env,
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
                ...(options.startupTimeout !== undefined
                  ? { startupTimeout: options.startupTimeout }
                  : {}),
                // Always attach when the Session is known: resolveDbPath may miss
                // on the first poll and succeed later (unlike a one-shot null that
                // dropped the probe for the whole turn).
                ...(knownSessionId !== undefined
                  ? {
                      observeStartup: observeOpencodeStartupActivity({
                        sessionId: knownSessionId,
                        startedAfterMs,
                        resolveDbPath: resolveStartupActivityDbPath,
                      }),
                    }
                  : {}),
                observerLabel: "OpenCode",
                parseLine: (line) => {
                  const sessionId = parseSessionIdFromLine(line)
                  const errorClassification =
                    parseErrorClassificationFromLine(line)
                  const retryAt = parseProviderRetryAtFromLine(line)
                  if (command !== undefined) {
                    const commandText = parseCommandTaskResultFromLine(
                      line,
                      command,
                    )
                    if (commandText !== undefined) {
                      return {
                        ...(sessionId !== undefined ? { sessionId } : {}),
                        ...(errorClassification !== undefined
                          ? { errorClassification }
                          : {}),
                        ...(retryAt !== undefined ? { retryAt } : {}),
                        finalizeText: commandText,
                      }
                    }
                  }
                  return {
                    ...(sessionId !== undefined ? { sessionId } : {}),
                    ...(errorClassification !== undefined
                      ? { errorClassification }
                      : {}),
                    ...(retryAt !== undefined ? { retryAt } : {}),
                    text: parseAssistantTextFromLine(line),
                  }
                },
                stdin: turnStdin,
              })
              const streamed = yield* turnSessionId === undefined ||
              command === undefined
                ? turn
                : stopSessionOnAbort(turnSessionId, turn)
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
          startTurn: Effect.fn("Opencode.startTurn")((input: StartTurnInput) =>
            runTurn(input),
          ),
          continueTurn: Effect.fn("Opencode.continueTurn")(
            (input: ContinueTurnInput) =>
              retrySilentKnownSessionStartup(() => runTurn(input), {
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
