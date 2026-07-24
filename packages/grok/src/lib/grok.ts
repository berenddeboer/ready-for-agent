import { randomUUID } from "node:crypto"
import { Duration, Effect, Layer } from "effect"
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
import { buildRunArgs } from "./build-args.js"
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
        const binary = options.binary ?? DEFAULT_BINARY
        const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
        const environment = makeGrokEnvironment()

        const inspect = Effect.fn("Grok.inspect")(function* (
          input: InspectInput,
        ) {
          const result = yield* runCliCapture({
            spawner,
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

            const args = buildRunArgs({
              prompt: input.prompt,
              cwd: input.cwd,
              model: input.model,
              thinkingLevel: input.thinkingLevel,
              ...(input.resume
                ? { resumeSessionId: input.sessionId }
                : { sessionId: input.sessionId }),
              ...(input.command !== undefined
                ? { command: input.command }
                : {}),
            })

            let stream = createGrokStreamParseState()

            const turn = yield* runCliTurn({
              spawner,
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
                  return {}
                }
                if (stream.maxTurnsReached) {
                  return {}
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
              })
            }
            if (stream.maxTurnsReached) {
              return yield* new AgentBackendExitError({
                exitCode: 1,
                cwd: input.cwd,
                sessionId: input.sessionId,
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
          })

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
