import { Context, Duration, Effect, Layer, Ref, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { buildRunArgs, shouldUsePromptStdin } from "./build-args.js"
import { collectChildStdout } from "./collect-child-stdout.js"
import { makeOpencodeEnvironment } from "./environment.js"
import {
  type OpencodeConfigError,
  OpencodeExitError,
  OpencodeIncompleteOutputError,
  OpencodeTimeoutError,
  SessionIdNotFoundError,
} from "./errors.js"
import { parseAssistantTextFromLine } from "./parse-assistant-text.js"
import { parseSessionIdFromLine } from "./parse-session-id.js"
import { parseVerboseModelsOutputDetailed } from "./parse-verbose-models.js"
import type {
  ContinueInput,
  ListModelsInput,
  OpencodeLayerOptions,
  OpencodeModel,
  OpencodeRunResult,
  StartInput,
} from "./types.js"

const DEFAULT_TIMEOUT = Duration.minutes(30)
const DEFAULT_BINARY = "opencode"

export type OpencodeError =
  | OpencodeExitError
  | OpencodeIncompleteOutputError
  | OpencodeTimeoutError
  | SessionIdNotFoundError
  | PlatformError

export type OpencodeLayerError = OpencodeConfigError

export class Opencode extends Context.Service<
  Opencode,
  {
    readonly start: (
      input: StartInput,
    ) => Effect.Effect<OpencodeRunResult, OpencodeError>
    readonly continue: (
      input: ContinueInput,
    ) => Effect.Effect<OpencodeRunResult, OpencodeError>
    /** Lists models (with variants) from OpenCode's active providers. */
    readonly listModels: (
      input: ListModelsInput,
    ) => Effect.Effect<ReadonlyArray<OpencodeModel>, OpencodeError>
  }
>()("@ready-for-agent/opencode/Opencode") {
  static layer = (options: OpencodeLayerOptions) =>
    Layer.effect(
      Opencode,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const binary = options.binary ?? DEFAULT_BINARY
        const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
        const environment = yield* makeOpencodeEnvironment({
          keymaxxerMcpUrl: options.keymaxxerMcpUrl,
        })

        const listModels = Effect.fn("Opencode.listModels")(function* (
          input: ListModelsInput,
        ) {
          const timeout = input.timeout ?? defaultTimeout
          const timeoutMs = Duration.toMillis(timeout)
          const command = ChildProcess.make(binary, ["models", "--verbose"], {
            cwd: input.cwd,
            env: environment,
            extendEnv: false,
            stdin: "ignore",
            stderr: "ignore",
          })

          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(command)
              return yield* collectChildStdout(handle)
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

          const parsed = parseVerboseModelsOutputDetailed(result.stdout)
          if (!parsed.complete) {
            return yield* new OpencodeIncompleteOutputError({
              cwd: input.cwd,
              byteLength: Buffer.byteLength(result.stdout, "utf8"),
            })
          }

          return parsed.models
        })

        const run = (input: {
          readonly prompt: string
          readonly cwd: string
          readonly model: string
          readonly variant: string
          readonly sessionId?: string
          readonly command?: string
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
              ...(input.command !== undefined
                ? { command: input.command }
                : {}),
            })
            const promptOnStdin =
              input.command === undefined && shouldUsePromptStdin(input.prompt)

            const command = ChildProcess.make(binary, args, {
              cwd: input.cwd,
              env: environment,
              extendEnv: false,
              stdin: promptOnStdin
                ? Stream.fromIterable([new TextEncoder().encode(input.prompt)])
                : "ignore",
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

  /** Test/integration helper with Keymaxxer enabled by default. */
  static layerForTests = (
    keymaxxerMcpUrl = "http://127.0.0.1:6057/test-cap/mcp",
  ) => Opencode.layer({ keymaxxerMcpUrl })
}
