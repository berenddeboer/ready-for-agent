import { randomUUID } from "node:crypto"
import { Duration, Effect, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  AGENT_BACKEND_IDS,
  AgentBackend,
  AgentBackendConfigError,
  type AgentBackendError,
  AgentBackendExitError,
  type ContinueTurnInput,
  type InspectInput,
  type StartTurnInput,
  malformedOutput,
  runCliCapture,
  runCliTurn,
} from "@ready-for-agent/agent-backend"
import {
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
export class Grok {
  static layer = (options: GrokLayerOptions = {}) =>
    Layer.effect(
      AgentBackend,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const fs = yield* FileSystem.FileSystem
        const binary = options.binary ?? DEFAULT_BINARY
        const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
        const environment = makeGrokEnvironment()

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
          readonly resume: boolean
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
              if (!input.resume && input.onSessionId !== undefined) {
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
                ...(input.resume
                  ? { resumeSessionId: input.sessionId }
                  : { sessionId: input.sessionId }),
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
                return yield* new AgentBackendExitError({
                  exitCode: 1,
                  cwd: input.cwd,
                  sessionId: input.sessionId,
                  message: stream.errorMessage,
                })
              }
              if (stream.maxTurnsReached) {
                return yield* new AgentBackendExitError({
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
              resume: false,
            }),
          ),
          continueTurn: Effect.fn("Grok.continueTurn")(
            (input: ContinueTurnInput) =>
              runTurn({
                ...input,
                sessionId: input.sessionId,
                resume: true,
              }),
          ),
        })
      }),
    )

  static layerForTests = () => Grok.layer({})
}
