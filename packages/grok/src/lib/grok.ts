import { randomUUID } from "node:crypto"
import { Duration, Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  AcpClient,
  type AcpClientError,
  AcpProcessExitError,
  AcpProtocolError,
  AcpSessionId,
  AcpSpawnError,
} from "@ready-for-agent/acp-client"
import {
  AGENT_BACKEND_IDS,
  AgentBackend,
  AgentBackendConfigError,
  type AgentBackendError,
  AgentBackendExitError,
  AgentBackendNotInstalledError,
  AgentBackendStartupTimeoutError,
  AgentBackendTimeoutError,
  type ContinueTurnInput,
  DEFAULT_FORCE_KILL_AFTER,
  DEFAULT_STARTUP_TIMEOUT,
  type InspectInput,
  type StartTurnInput,
  formatAgentCliNotFoundRemediation,
  killProcessTree,
  malformedOutput,
  retrySilentKnownSessionStartup,
  runCliCapture,
  runCliTurn,
} from "@ready-for-agent/agent-backend"
import {
  buildAcpContinueArgs,
  buildPromptBody,
  buildRunArgs,
  shouldUsePromptFile,
} from "./build-args.js"
import { makeGrokEnvironment } from "./environment.js"
import { parseGrokModelsOutput } from "./parse-models.js"
import {
  createGrokStreamParseState,
  foldGrokStreamLine,
  grokAssistantText,
  isSuccessfulGrokEnd,
} from "./parse-stream.js"
import type { GrokLayerOptions } from "./types.js"

const DEFAULT_TIMEOUT = Duration.minutes(30)
const DEFAULT_BINARY = "grok"

const GROK_BACKEND = {
  id: AGENT_BACKEND_IDS.grok,
  label: "Grok Build",
} as const

/**
 * Grok Build adapter implementing the backend-neutral AgentBackend contract.
 */
export const Grok = {
  layer: (options: GrokLayerOptions = {}) =>
    Layer.effect(
      AgentBackend,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const fs = yield* FileSystem.FileSystem
        const acp = yield* AcpClient
        const binary = options.binary ?? DEFAULT_BINARY
        const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
        const startupTimeout = options.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT
        const forceKillAfter =
          options.forceKillAfter ?? DEFAULT_FORCE_KILL_AFTER
        const environment = makeGrokEnvironment()

        const mapAcpError =
          (input: { readonly cwd: string; readonly sessionId: string }) =>
          (error: AcpClientError | AgentBackendError): AgentBackendError => {
            if (error instanceof AcpSpawnError) {
              if (error.message.includes("not found")) {
                return new AgentBackendNotInstalledError({
                  message: formatAgentCliNotFoundRemediation({
                    backendLabel: GROK_BACKEND.label,
                    binary,
                  }),
                  backend: GROK_BACKEND,
                  binary,
                  cause: error,
                })
              }
              return AgentBackendExitError.new({
                exitCode: 1,
                cwd: input.cwd,
                sessionId: input.sessionId,
                message: error.message,
              })
            }
            if (error instanceof AcpProcessExitError) {
              return AgentBackendExitError.new({
                exitCode: error.exitCode ?? 1,
                cwd: input.cwd,
                sessionId: input.sessionId,
                message: error.message,
              })
            }
            if (error instanceof AcpProtocolError) {
              return malformedOutput(input.cwd, error.message)
            }
            return error
          }

        const inspect = Effect.fn("Grok.inspect")(function* (
          input: InspectInput,
        ) {
          const result = yield* runCliCapture({
            spawner,
            backend: GROK_BACKEND,
            binary,
            args: ["--no-auto-update", "models"],
            cwd: input.cwd,
            env: environment,
            timeout: input.timeout ?? defaultTimeout,
          })

          const parsed = parseGrokModelsOutput(result.stdout)
          if (!parsed.authenticated) {
            return yield* new AgentBackendConfigError({
              message:
                "Grok Build is not authenticated. Run `grok login` (or set XAI_API_KEY), then Recheck Agent Backend.",
            })
          }
          if (!parsed.complete) {
            return yield* malformedOutput(input.cwd, result.stdout)
          }

          return {
            backend: GROK_BACKEND,
            models: parsed.models.map((model) => ({
              id: model.id,
              thinkingLevels: [...model.thinkingLevels],
            })),
          }
        })

        /**
         * Park an oversized prompt body in a temp file for the life of the turn.
         *
         * Headless Grok ignores piped stdin, so `--prompt-file` is the only way
         * to keep a large prompt off argv. The file is scoped to the turn and
         * owner-only because prompts carry Work Item context.
         */
        const writePromptFile = (body: string) =>
          Effect.gen(function* () {
            const path = yield* fs.makeTempFileScoped({
              prefix: "ready-for-agent-grok-prompt-",
              suffix: ".md",
            })
            yield* fs.writeFileString(path, body)
            yield* fs.chmod(path, 0o600)
            return path
          })

        const runTurn = (input: {
          readonly prompt: string
          readonly cwd: string
          readonly model: string
          readonly thinkingLevel: string | null
          readonly sessionId: string
          readonly command?: string
          readonly timeout?: Duration.Input
          readonly onSessionId?: StartTurnInput["onSessionId"]
        }): Effect.Effect<
          { readonly sessionId: string; readonly assistantText: string },
          AgentBackendError
        > =>
          // Scoped so an oversized prompt file lives only as long as the turn.
          Effect.scoped(
            Effect.gen(function* () {
              if (input.onSessionId !== undefined) {
                yield* input.onSessionId(input.sessionId).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Grok onSessionId observer failed", {
                      sessionId: input.sessionId,
                      error,
                    }),
                  ),
                )
              }

              const promptInput = {
                prompt: input.prompt,
                ...(input.command !== undefined
                  ? { command: input.command }
                  : {}),
              }
              const promptFile = shouldUsePromptFile(promptInput)
                ? yield* writePromptFile(buildPromptBody(promptInput))
                : undefined
              const args = buildRunArgs({
                ...promptInput,
                cwd: input.cwd,
                model: input.model,
                thinkingLevel: input.thinkingLevel,
                sessionId: input.sessionId,
                ...(promptFile !== undefined ? { promptFile } : {}),
              })

              let stream = createGrokStreamParseState()

              const turn = yield* runCliTurn({
                spawner,
                backend: GROK_BACKEND,
                binary,
                args,
                cwd: input.cwd,
                env: environment,
                timeout: input.timeout ?? defaultTimeout,
                knownSessionId: input.sessionId,
                observerLabel: "Grok Build",
                parseLine: (line) => {
                  stream = foldGrokStreamLine(stream, line)

                  if (stream.errorMessage !== undefined) {
                    return { errorMessage: stream.errorMessage }
                  }
                  if (stream.maxTurnsReached) {
                    return {
                      errorMessage:
                        "Grok Build reached the maximum number of turns",
                    }
                  }
                  if (stream.endSeen && isSuccessfulGrokEnd(stream)) {
                    const endSessionId = stream.endSessionId ?? input.sessionId
                    return {
                      sessionId: endSessionId,
                      finalizeText: grokAssistantText(stream),
                    }
                  }
                  return {}
                },
                stdin: "ignore",
              })

              if (stream.malformedLine) {
                return yield* malformedOutput(
                  input.cwd,
                  "(malformed stream line)",
                )
              }
              if (stream.errorMessage !== undefined) {
                return yield* AgentBackendExitError.new({
                  exitCode: 1,
                  cwd: input.cwd,
                  sessionId: input.sessionId,
                  message: stream.errorMessage,
                })
              }
              if (stream.maxTurnsReached) {
                return yield* AgentBackendExitError.new({
                  exitCode: 1,
                  cwd: input.cwd,
                  sessionId: input.sessionId,
                  message: "Grok Build reached the maximum number of turns",
                })
              }
              if (!stream.endSeen || !isSuccessfulGrokEnd(stream)) {
                return yield* malformedOutput(
                  input.cwd,
                  "(missing or unsuccessful terminal end event)",
                )
              }
              if (
                stream.endSessionId !== undefined &&
                stream.endSessionId !== input.sessionId
              ) {
                return yield* malformedOutput(
                  input.cwd,
                  `(session id mismatch: expected ${input.sessionId}, got ${stream.endSessionId})`,
                )
              }

              return {
                sessionId: input.sessionId,
                assistantText: turn.assistantText,
              }
            }),
          )

        return AgentBackend.of({
          inspect,
          startTurn: Effect.fn("Grok.startTurn")((input: StartTurnInput) =>
            runTurn({
              ...input,
              sessionId: randomUUID(),
            }),
          ),
          continueTurn: Effect.fn("Grok.continueTurn")(
            (input: ContinueTurnInput) => {
              const timeout = input.timeout ?? defaultTimeout
              const timeoutMs = Duration.toMillis(timeout)
              const startupTimeoutMs = Duration.toMillis(startupTimeout)
              const runContinue = () =>
                Effect.scoped(
                  Effect.gen(function* () {
                    const connection = yield* acp.connect({
                      command: binary,
                      args: buildAcpContinueArgs({
                        model: input.model,
                        thinkingLevel: input.thinkingLevel,
                      }),
                      cwd: input.cwd,
                      env: environment,
                    })
                    yield* Effect.addFinalizer(() =>
                      killProcessTree(connection.pid, { forceKillAfter }).pipe(
                        Effect.timeout(
                          Duration.millis(
                            Duration.toMillis(forceKillAfter) + 1_000,
                          ),
                        ),
                        Effect.ignore,
                      ),
                    )
                    const initialized = yield* connection.initialize().pipe(
                      Effect.timeoutOrElse({
                        duration: startupTimeout,
                        orElse: () =>
                          new AgentBackendStartupTimeoutError({
                            cwd: input.cwd,
                            startupTimeoutMs,
                            sessionId: input.sessionId,
                          }),
                      }),
                    )
                    if (
                      initialized.authMethods.some(
                        (method) => method.id === "cached_token",
                      )
                    ) {
                      yield* connection.authenticate({
                        methodId: "cached_token",
                      })
                    }
                    const sessionId = AcpSessionId.make(input.sessionId)
                    const sessionMeta = { yoloMode: true }
                    yield* connection
                      .resumeSession({
                        sessionId,
                        cwd: input.cwd,
                        _meta: sessionMeta,
                      })
                      .pipe(
                        Effect.catchTag("AcpProtocolError", () =>
                          connection
                            .loadSession({
                              sessionId,
                              cwd: input.cwd,
                              _meta: sessionMeta,
                            })
                            .pipe(
                              Effect.mapError((error) =>
                                error instanceof AcpProtocolError
                                  ? AgentBackendExitError.new({
                                      exitCode: 1,
                                      cwd: input.cwd,
                                      sessionId: input.sessionId,
                                      message: `Grok Build could not restore Session ${input.sessionId}: ${error.message}`,
                                    })
                                  : error,
                              ),
                            ),
                        ),
                      )
                    const prompt = yield* connection.prompt({
                      sessionId,
                      prompt: buildPromptBody({
                        prompt: input.prompt,
                        ...(input.command !== undefined
                          ? { command: input.command }
                          : {}),
                      }),
                      _meta: { yoloMode: true },
                    })
                    if (prompt.sessionId !== input.sessionId) {
                      return yield* malformedOutput(
                        input.cwd,
                        `(session id mismatch: expected ${input.sessionId}, got ${prompt.sessionId})`,
                      )
                    }
                    if (prompt.stopReason !== "end_turn") {
                      return yield* AgentBackendExitError.new({
                        exitCode: 1,
                        cwd: input.cwd,
                        sessionId: input.sessionId,
                        message: `Grok Build stopped: ${prompt.stopReason}`,
                      })
                    }
                    return {
                      sessionId: input.sessionId,
                      assistantText: prompt.assistantText,
                    }
                  }),
                ).pipe(
                  Effect.mapError(mapAcpError(input)),
                  Effect.timeoutOrElse({
                    duration: timeout,
                    orElse: () =>
                      new AgentBackendTimeoutError({
                        cwd: input.cwd,
                        timeoutMs,
                        sessionId: input.sessionId,
                      }),
                  }),
                )

              return retrySilentKnownSessionStartup(runContinue, {
                sessionId: input.sessionId,
                model: input.model,
                observerLabel: "Grok Build",
              })
            },
          ),
        })
      }),
    ).pipe(Layer.provide(AcpClient.layer)),

  layerForTests: () => Grok.layer({}),
}
