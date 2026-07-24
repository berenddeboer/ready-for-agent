import { Duration, Effect, Layer, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  AGENT_BACKEND_IDS,
  AgentBackend,
  AgentBackendConfigError,
  type AgentBackendError,
  type ContinueTurnInput,
  type InspectInput,
  type StartTurnInput,
  malformedOutput,
  runCliCapture,
  runCliTurn,
} from "@ready-for-agent/agent-backend"
import { buildRunArgs, shouldUsePromptStdin } from "./build-args.js"
import { makeOpencodeEnvironment } from "./environment.js"
import type { OpencodeConfigError } from "./errors.js"
import { parseAssistantTextFromLine } from "./parse-assistant-text.js"
import { parseCommandTaskResultFromLine } from "./parse-command-task-result.js"
import { parseSessionIdFromLine } from "./parse-session-id.js"
import { parseVerboseModelsOutputDetailed } from "./parse-verbose-models.js"
import type { OpencodeLayerOptions } from "./types.js"

const DEFAULT_TIMEOUT = Duration.minutes(30)
const DEFAULT_BINARY = "opencode"

const OPENCODE_BACKEND = {
  id: AGENT_BACKEND_IDS.opencode,
  label: "OpenCode",
} as const

export type OpencodeLayerError = OpencodeConfigError

/**
 * OpenCode adapter implementing the backend-neutral AgentBackend contract.
 */
export class Opencode {
  static layer = (options: OpencodeLayerOptions) =>
    Layer.effect(
      AgentBackend,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const binary = options.binary ?? DEFAULT_BINARY
        const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
        const environment = yield* makeOpencodeEnvironment({
          keymaxxerMcpUrl: options.keymaxxerMcpUrl,
        }).pipe(
          Effect.mapError(
            (error) =>
              new AgentBackendConfigError({
                message: error.message,
                ...(error.cause !== undefined ? { cause: error.cause } : {}),
              }),
          ),
        )

        const inspect = Effect.fn("Opencode.inspect")(function* (
          input: InspectInput,
        ) {
          const result = yield* runCliCapture({
            spawner,
            binary,
            args: ["models", "--verbose"],
            cwd: input.cwd,
            env: environment,
            timeout: input.timeout ?? defaultTimeout,
          })

          const parsed = parseVerboseModelsOutputDetailed(result.stdout)
          if (!parsed.complete) {
            return yield* malformedOutput(input.cwd, result.stdout)
          }

          return {
            backend: OPENCODE_BACKEND,
            models: parsed.models.map((model) => ({
              id: model.id,
              thinkingLevels: model.variants,
            })),
          }
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
          const args = buildRunArgs({
            prompt: input.prompt,
            cwd: input.cwd,
            model: input.model,
            thinkingLevel: input.thinkingLevel,
            sessionId: input.sessionId,
            ...(input.command !== undefined ? { command: input.command } : {}),
          })
          const promptOnStdin =
            input.command === undefined && shouldUsePromptStdin(input.prompt)
          const commandName = input.command

          return runCliTurn({
            spawner,
            binary,
            args,
            cwd: input.cwd,
            env: environment,
            timeout: input.timeout ?? defaultTimeout,
            knownSessionId: input.sessionId,
            ...(input.onSessionId !== undefined
              ? { onSessionId: input.onSessionId }
              : {}),
            observerLabel: "OpenCode",
            parseLine: (line) => {
              const sessionId = parseSessionIdFromLine(line)
              if (commandName !== undefined) {
                const commandText = parseCommandTaskResultFromLine(
                  line,
                  commandName,
                )
                if (commandText !== undefined) {
                  return {
                    ...(sessionId !== undefined ? { sessionId } : {}),
                    finalizeText: commandText,
                  }
                }
              }
              return {
                ...(sessionId !== undefined ? { sessionId } : {}),
                text: parseAssistantTextFromLine(line),
              }
            },
            stdin: promptOnStdin
              ? Stream.fromIterable([new TextEncoder().encode(input.prompt)])
              : "ignore",
          })
        }

        return AgentBackend.of({
          inspect,
          startTurn: Effect.fn("Opencode.startTurn")((input: StartTurnInput) =>
            runTurn(input),
          ),
          continueTurn: Effect.fn("Opencode.continueTurn")(
            (input: ContinueTurnInput) => runTurn(input),
          ),
        })
      }),
    )

  /** Test/integration helper with Keymaxxer enabled by default. */
  static layerForTests = (
    keymaxxerMcpUrl = "http://127.0.0.1:6057/test-cap/mcp",
  ) => Opencode.layer({ keymaxxerMcpUrl })
}
