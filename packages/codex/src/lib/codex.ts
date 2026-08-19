import { Duration, Effect, Layer, Stream } from "effect"
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
  retrySilentKnownSessionStartup,
  runCliCapture,
  runCliTurn,
} from "@ready-for-agent/agent-backend"
import {
  buildPromptBody,
  buildRunArgs,
  shouldUsePromptStdin,
} from "./build-args.js"
import { resolveCodexUserProvider } from "./custom-provider.js"
import { makeCodexEnvironment } from "./environment.js"
import { parseCodexLoginStatus } from "./parse-login-status.js"
import {
  codexAssistantText,
  createCodexStreamParseState,
  foldCodexStreamLine,
  isSuccessfulCodexTurn,
} from "./parse-stream.js"
import {
  CODEX_STATIC_CATALOG,
  CODEX_UNAUTHENTICATED_MESSAGE,
  type CodexLayerOptions,
} from "./types.js"

const DEFAULT_TIMEOUT = Duration.minutes(30)
const DEFAULT_BINARY = "codex"

const CODEX_BACKEND = {
  id: AGENT_BACKEND_IDS.codex,
  label: "Codex Build",
} as const

/** Cap CLI probe text so Unavailable reasons stay readable in the UI. */
const clipProbeOutput = (text: string, maxChars = 240): string => {
  const trimmed = text.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) {
    return "(no output)"
  }
  if (trimmed.length <= maxChars) {
    return trimmed
  }
  return `${trimmed.slice(0, maxChars)}…`
}

/**
 * Codex Build adapter implementing the backend-neutral AgentBackend contract.
 *
 * Registration, static catalog, and provider-aware readiness inspection
 * ship with this layer. First-party login uses `codex login status`; a
 * valid user-level custom `model_provider` with `Not logged in` is Ready
 * after local `codex debug models --bundled`, without running token
 * commands or `codex exec`.
 * Agent Turns run `codex exec --json` unsandboxed, capture `thread_id` from
 * `thread.started` via `onSessionId` while the first turn is still running,
 * resume later turns with `codex exec resume`, and normalize the JSONL stream
 * into Session ID + ordered final assistant text (issue #557 / ADR 0041).
 */
export const Codex = {
  layer: (options: CodexLayerOptions = {}) =>
    Layer.effect(
      AgentBackend,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const binary = options.binary ?? DEFAULT_BINARY
        const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
        const environment = makeCodexEnvironment(
          options.environment !== undefined
            ? { environment: options.environment }
            : {},
        )

        const inspect = Effect.fn("Codex.inspect")(function* (
          input: InspectInput,
        ) {
          // Real `codex login status` prints markers with eprintln! (stderr
          // only). Capture stderr, allow non-zero exit so "Not logged in"
          // (exit 1) keeps text for actionable ConfigError mapping.
          const result = yield* runCliCapture({
            spawner,
            backend: CODEX_BACKEND,
            binary,
            args: ["login", "status"],
            cwd: input.cwd,
            env: environment,
            timeout: input.timeout ?? defaultTimeout,
            allowNonZeroExit: true,
            captureStderr: true,
          })

          const statusOutput = [result.stdout, result.stderr]
            .filter((part) => part.length > 0)
            .join("\n")
          const status = parseCodexLoginStatus(statusOutput, result.exitCode)
          if (status.kind === "unauthenticated") {
            const provider = resolveCodexUserProvider({ env: environment })
            if (provider.kind === "malformed") {
              return yield* new AgentBackendConfigError({
                message: provider.message,
              })
            }
            if (provider.kind === "firstParty") {
              return yield* new AgentBackendConfigError({
                message: CODEX_UNAUTHENTICATED_MESSAGE,
              })
            }

            // Custom providers use command-backed or env-key auth that
            // `codex login status` never inspects. Validate the CLI and
            // bundled catalog locally with `codex debug models --bundled`
            // — never unbundled refresh (that runs provider token commands
            // and GET /models), never `codex exec`.
            const debug = yield* runCliCapture({
              spawner,
              backend: CODEX_BACKEND,
              binary,
              args: ["debug", "models", "--bundled"],
              cwd: input.cwd,
              env: environment,
              timeout: input.timeout ?? defaultTimeout,
              allowNonZeroExit: true,
              captureStderr: true,
            })
            if (debug.exitCode !== 0) {
              const debugOutput = [debug.stdout, debug.stderr]
                .filter((part) => part.length > 0)
                .join("\n")
              const probe = clipProbeOutput(debugOutput)
              return yield* new AgentBackendConfigError({
                message: `Codex custom provider "${provider.providerId}" is configured, but \`codex debug models --bundled\` failed (exit ${debug.exitCode}): ${probe}`,
              })
            }

            return {
              backend: CODEX_BACKEND,
              models: CODEX_STATIC_CATALOG.map((model) => ({
                id: model.id,
                thinkingLevels: [...model.thinkingLevels],
              })),
              warnings: [
                `Codex custom provider "${provider.providerId}" is configured; its credentials will be validated on the first Agent Turn.`,
              ],
            }
          }
          if (status.kind === "failed") {
            return yield* AgentBackendExitError.new({
              exitCode: status.exitCode,
              cwd: input.cwd,
              message: `Codex Build readiness probe failed (exit ${status.exitCode}): ${clipProbeOutput(statusOutput)}`,
            })
          }
          if (status.kind === "malformed") {
            return yield* malformedOutput(input.cwd, statusOutput)
          }

          return {
            backend: CODEX_BACKEND,
            models: CODEX_STATIC_CATALOG.map((model) => ({
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
          readonly sessionId?: string
          readonly resume: boolean
          readonly command?: string
          readonly timeout?: Duration.Input
          readonly onSessionId?: StartTurnInput["onSessionId"]
        }): Effect.Effect<
          { readonly sessionId: string; readonly assistantText: string },
          AgentBackendError
        > =>
          Effect.gen(function* () {
            const promptInput = {
              prompt: input.prompt,
              ...(input.command !== undefined
                ? { command: input.command }
                : {}),
            }
            const args = buildRunArgs({
              ...promptInput,
              model: input.model,
              thinkingLevel: input.thinkingLevel,
              ...(input.resume && input.sessionId !== undefined
                ? { resumeSessionId: input.sessionId }
                : {}),
            })
            const promptOnStdin = shouldUsePromptStdin(promptInput)

            let stream = createCodexStreamParseState()
            // On resume, the Session ID is already durable; seed parse state so
            // a missing thread.started still succeeds with the known ID.
            if (input.sessionId !== undefined) {
              stream = { ...stream, threadId: input.sessionId }
            }

            const turn = yield* runCliTurn({
              spawner,
              backend: CODEX_BACKEND,
              binary,
              args,
              cwd: input.cwd,
              env: environment,
              timeout: input.timeout ?? defaultTimeout,
              ...(input.sessionId !== undefined
                ? { knownSessionId: input.sessionId }
                : {}),
              ...(input.onSessionId !== undefined
                ? { onSessionId: input.onSessionId }
                : {}),
              observerLabel: "Codex Build",
              parseLine: (line) => {
                stream = foldCodexStreamLine(stream, line)

                if (stream.malformedLine) {
                  return {}
                }
                if (stream.turnFailed) {
                  return {
                    ...(stream.threadId !== undefined
                      ? { sessionId: stream.threadId }
                      : {}),
                    errorMessage:
                      stream.turnFailedMessage ?? "Codex turn.failed",
                  }
                }
                if (stream.turnCompleted && isSuccessfulCodexTurn(stream)) {
                  const finalizedSessionId = stream.threadId
                  if (finalizedSessionId === undefined) {
                    return {}
                  }
                  return {
                    sessionId: finalizedSessionId,
                    finalizeText: codexAssistantText(stream),
                  }
                }
                if (stream.threadId !== undefined) {
                  return { sessionId: stream.threadId }
                }
                return {}
              },
              stdin: promptOnStdin
                ? Stream.fromIterable([
                    new TextEncoder().encode(buildPromptBody(promptInput)),
                  ])
                : "ignore",
            })

            if (stream.malformedLine) {
              return yield* malformedOutput(
                input.cwd,
                "(malformed stream line)",
              )
            }
            if (stream.turnFailed) {
              yield* Effect.logWarning("Codex Build turn.failed", {
                sessionId: stream.threadId ?? input.sessionId,
                message: stream.turnFailedMessage ?? "Codex turn.failed",
              })
              return yield* AgentBackendExitError.new({
                exitCode: 1,
                cwd: input.cwd,
                message: stream.turnFailedMessage ?? "Codex turn.failed",
                ...(stream.threadId !== undefined
                  ? { sessionId: stream.threadId }
                  : input.sessionId !== undefined
                    ? { sessionId: input.sessionId }
                    : {}),
              })
            }
            if (!stream.turnCompleted || !isSuccessfulCodexTurn(stream)) {
              return yield* malformedOutput(
                input.cwd,
                "(missing or unsuccessful terminal turn.completed event)",
              )
            }

            const sessionId = stream.threadId ?? turn.sessionId
            if (
              input.sessionId !== undefined &&
              sessionId !== input.sessionId
            ) {
              return yield* malformedOutput(
                input.cwd,
                `(session id mismatch: expected ${input.sessionId}, got ${sessionId})`,
              )
            }

            return {
              sessionId,
              assistantText: turn.assistantText,
            }
          })

        return AgentBackend.of({
          inspect,
          startTurn: Effect.fn("Codex.startTurn")((input: StartTurnInput) =>
            runTurn({
              ...input,
              resume: false,
            }),
          ),
          continueTurn: Effect.fn("Codex.continueTurn")(
            (input: ContinueTurnInput) =>
              retrySilentKnownSessionStartup(
                () =>
                  runTurn({
                    ...input,
                    sessionId: input.sessionId,
                    resume: true,
                  }),
                {
                  sessionId: input.sessionId,
                  model: input.model,
                  observerLabel: "Codex Build",
                },
              ),
          ),
        })
      }),
    ),

  layerForTests: () => Codex.layer({}),
}
