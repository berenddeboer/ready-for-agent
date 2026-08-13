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
import {
  type OpencodePathEnv,
  resolveOpencodeDbPath,
} from "./opencode-db-path.js"
import { parseAssistantTextFromLine } from "./parse-assistant-text.js"
import { parseCommandTaskResultFromLine } from "./parse-command-task-result.js"
import { parseErrorClassificationFromLine } from "./parse-error-classification.js"
import { parseSessionIdFromLine } from "./parse-session-id.js"
import { parseVerboseModelsOutputDetailed } from "./parse-verbose-models.js"
import { observeOpencodeStartupActivity } from "./startup-activity.js"
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
        const inspect = Effect.fn("Opencode.inspect")(function* (
          input: InspectInput,
        ) {
          const result = yield* runCliCapture({
            spawner,
            backend: OPENCODE_BACKEND,
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
            env: environment as OpencodePathEnv,
          })
          if (resolved !== null) {
            cachedStartupActivityDbPath = resolved
          }
          return resolved
        }

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
          const promptInput = {
            prompt: input.prompt,
            ...(input.command !== undefined ? { command: input.command } : {}),
          }
          const args = buildRunArgs({
            ...promptInput,
            cwd: input.cwd,
            model: input.model,
            thinkingLevel: input.thinkingLevel,
            sessionId: input.sessionId,
          })
          const promptOnStdin = shouldUsePromptStdin(promptInput)
          const commandName = input.command
          // Snapshot just before spawn so only post-spawn task/child activity
          // disarms the startup window (not historical review attempts).
          const startedAfterMs = Date.now()
          const knownSessionId = input.sessionId

          return runCliTurn({
            spawner,
            backend: OPENCODE_BACKEND,
            binary,
            args,
            cwd: input.cwd,
            env: environment,
            timeout: input.timeout ?? defaultTimeout,
            knownSessionId: input.sessionId,
            ...(input.onSessionId !== undefined
              ? { onSessionId: input.onSessionId }
              : {}),
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
              const errorClassification = parseErrorClassificationFromLine(line)
              if (commandName !== undefined) {
                const commandText = parseCommandTaskResultFromLine(
                  line,
                  commandName,
                )
                if (commandText !== undefined) {
                  return {
                    ...(sessionId !== undefined ? { sessionId } : {}),
                    ...(errorClassification !== undefined
                      ? { errorClassification }
                      : {}),
                    finalizeText: commandText,
                  }
                }
              }
              return {
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(errorClassification !== undefined
                  ? { errorClassification }
                  : {}),
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
