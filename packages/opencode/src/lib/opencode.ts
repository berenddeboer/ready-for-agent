import { Context, Duration, Effect, Layer, Stream } from "effect"
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

        const listModels = (
          input: ListModelsInput,
        ): Effect.Effect<ReadonlyArray<string>, OpencodeError> =>
          Effect.gen(function* () {
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
        }): Effect.Effect<OpencodeRunResult, OpencodeError> =>
          Effect.gen(function* () {
            const timeout = input.timeout ?? defaultTimeout
            const timeoutMs = Duration.toMillis(timeout)
            const knownSessionId = input.sessionId
            let seenSessionId: string | undefined = knownSessionId

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
                  Stream.runFold(
                    (): { sessionId?: string; assistantText: string } => ({
                      assistantText: "",
                    }),
                    (acc, line) => {
                      const sessionId = parseSessionIdFromLine(line)
                      if (sessionId !== undefined) {
                        seenSessionId = sessionId
                      }
                      const text = parseAssistantTextFromLine(line)
                      return {
                        sessionId: sessionId ?? acc.sessionId,
                        assistantText:
                          text === undefined
                            ? acc.assistantText
                            : acc.assistantText.length === 0
                              ? text
                              : `${acc.assistantText}\n${text}`,
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
                Effect.fail(
                  new OpencodeTimeoutError({
                    cwd: input.cwd,
                    timeoutMs,
                    ...(seenSessionId !== undefined
                      ? { sessionId: seenSessionId }
                      : {}),
                  }),
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
          start: (input) => run(input),
          continue: (input) => run(input),
          listModels,
        }
      }),
    )

  /** Test/integration helper; production must pass keymaxxerMcpUrl explicitly. */
  static layerForTests = (
    keymaxxerMcpUrl = "http://127.0.0.1:5032/test-cap/mcp",
  ) => Opencode.layer({ keymaxxerMcpUrl })
}
