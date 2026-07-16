import { Context, Duration, Effect, Layer, Ref, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { buildRunArgs } from "./build-args.js"
import { makeOpencodeEnvironment } from "./environment.js"
import {
  OpencodeExitError,
  OpencodeTimeoutError,
  SessionIdNotFoundError,
} from "./errors.js"
import { parseAssistantTextFromLine } from "./parse-assistant-text.js"
import { parseSessionIdFromLine } from "./parse-session-id.js"
import type {
  ContinueInput,
  ListModelsInput,
  OpencodeLayerOptions,
  OpencodeRunResult,
  StartInput,
} from "./types.js"

const DEFAULT_TIMEOUT = Duration.minutes(30)
const DEFAULT_BINARY = "opencode"

export type OpencodeError =
  | OpencodeExitError
  | OpencodeTimeoutError
  | SessionIdNotFoundError
  | PlatformError

export class Opencode extends Context.Service<
  Opencode,
  {
    readonly start: (
      input: StartInput,
    ) => Effect.Effect<OpencodeRunResult, OpencodeError>
    readonly continue: (
      input: ContinueInput,
    ) => Effect.Effect<OpencodeRunResult, OpencodeError>
    /** Lists models from OpenCode's active providers for the working directory. */
    readonly listModels: (
      input: ListModelsInput,
    ) => Effect.Effect<ReadonlyArray<string>, OpencodeError>
  }
>()("@ready-for-agent/opencode/Opencode") {
  static layer = (options: OpencodeLayerOptions) =>
    Layer.effect(
      Opencode,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const binary = options.binary ?? DEFAULT_BINARY
        const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
        const environment = makeOpencodeEnvironment({
          keymaxxerMcpUrl: options.keymaxxerMcpUrl,
        })

        const listModels = Effect.fn("Opencode.listModels")(function* (
          input: ListModelsInput,
        ) {
          const timeout = input.timeout ?? defaultTimeout
          const timeoutMs = Duration.toMillis(timeout)
          const command = ChildProcess.make(binary, ["models"], {
            cwd: input.cwd,
            env: environment,
            extendEnv: false,
            stdin: "ignore",
            stderr: "ignore",
          })

          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(command)
              const collectModels = Stream.decodeText(handle.stdout).pipe(
                Stream.splitLines,
                Stream.runFold(
                  (): ReadonlyArray<string> => [],
                  (models, line) => {
                    const model = line.trim()
                    return model.length === 0 ? models : [...models, model]
                  },
                ),
              )

              const [exitCode, models] = yield* Effect.all(
                [handle.exitCode, collectModels],
                { concurrency: 2 },
              )

              return { exitCode: Number(exitCode), models }
            }),
          ).pipe(
            Effect.timeout(timeout),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                new OpencodeTimeoutError({ cwd: input.cwd, timeoutMs }),
              ),
            ),
          )

          if (result.exitCode !== 0) {
            return yield* new OpencodeExitError({
              exitCode: result.exitCode,
              cwd: input.cwd,
            })
          }

          return result.models
        })

        const run = (input: {
          readonly prompt: string
          readonly cwd: string
          readonly model: string
          readonly variant: string
          readonly sessionId?: string
          readonly timeout?: Duration.Input
          readonly onSessionId?: StartInput["onSessionId"]
        }): Effect.Effect<OpencodeRunResult, OpencodeError> =>
          Effect.gen(function* () {
            const timeout = input.timeout ?? defaultTimeout
            const timeoutMs = Duration.toMillis(timeout)
            const knownSessionId = input.sessionId
            const seenSessionId = yield* Ref.make(knownSessionId)
            const sessionIdNotified = yield* Ref.make(false)

            const args = buildRunArgs({
              prompt: input.prompt,
              cwd: input.cwd,
              model: input.model,
              variant: input.variant,
              sessionId: input.sessionId,
            })

            const command = ChildProcess.make(binary, args, {
              cwd: input.cwd,
              env: environment,
              extendEnv: false,
              stdin: "ignore",
              stderr: "ignore",
            })

            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* spawner.spawn(command)

                const collectOutput = Stream.decodeText(handle.stdout).pipe(
                  Stream.splitLines,
                  Stream.map((line) => ({
                    sessionId: parseSessionIdFromLine(line),
                    text: parseAssistantTextFromLine(line),
                  })),
                  Stream.tap(({ sessionId }) =>
                    sessionId === undefined
                      ? Effect.void
                      : Effect.gen(function* () {
                          yield* Ref.set(seenSessionId, sessionId)
                          const alreadyNotified = yield* Ref.getAndSet(
                            sessionIdNotified,
                            true,
                          )
                          if (
                            alreadyNotified ||
                            input.onSessionId === undefined
                          ) {
                            return
                          }
                          yield* input.onSessionId(sessionId).pipe(
                            Effect.catch((error) =>
                              Effect.logWarning(
                                "OpenCode onSessionId observer failed",
                                { sessionId, error },
                              ),
                            ),
                            Effect.forkDetach({ startImmediately: true }),
                          )
                        }),
                  ),
                  Stream.runFold(
                    (): { sessionId?: string; assistantText: string } => ({
                      assistantText: "",
                    }),
                    (acc, event) => {
                      return {
                        sessionId: event.sessionId ?? acc.sessionId,
                        assistantText:
                          event.text === undefined
                            ? acc.assistantText
                            : acc.assistantText.length === 0
                              ? event.text
                              : `${acc.assistantText}\n${event.text}`,
                      }
                    },
                  ),
                )

                const [exitCode, output] = yield* Effect.all(
                  [handle.exitCode, collectOutput],
                  { concurrency: 2 },
                )

                return {
                  exitCode: Number(exitCode),
                  sessionId: output.sessionId,
                  assistantText: output.assistantText,
                }
              }),
            ).pipe(
              Effect.timeout(timeout),
              Effect.catchTag("TimeoutError", () =>
                Ref.get(seenSessionId).pipe(
                  Effect.flatMap(
                    (sessionId) =>
                      new OpencodeTimeoutError({
                        cwd: input.cwd,
                        timeoutMs,
                        ...(sessionId !== undefined ? { sessionId } : {}),
                      }),
                  ),
                ),
              ),
            )

            if (result.exitCode !== 0) {
              const sessionId = result.sessionId ?? knownSessionId
              return yield* new OpencodeExitError({
                exitCode: result.exitCode,
                cwd: input.cwd,
                ...(sessionId !== undefined ? { sessionId } : {}),
              })
            }

            const sessionId = result.sessionId ?? knownSessionId
            if (sessionId === undefined) {
              return yield* new SessionIdNotFoundError({ cwd: input.cwd })
            }

            return {
              sessionId,
              assistantText: result.assistantText,
            }
          })

        return {
          start: Effect.fn("Opencode.start")((input: StartInput) => run(input)),
          continue: Effect.fn("Opencode.continue")((input: ContinueInput) =>
            run(input),
          ),
          listModels,
        }
      }),
    )

  /** Test/integration helper; production must pass keymaxxerMcpUrl explicitly. */
  static layerForTests = (
    keymaxxerMcpUrl = "http://127.0.0.1:5032/test-cap/mcp",
  ) => Opencode.layer({ keymaxxerMcpUrl })
}
