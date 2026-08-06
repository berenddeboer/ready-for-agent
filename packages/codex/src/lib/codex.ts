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
  runCliCapture,
  runCliTurn,
} from "@ready-for-agent/agent-backend"
import {
  buildPromptBody,
  buildRunArgs,
  shouldUsePromptStdin,
} from "./build-args.js"
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
 * Registration, static catalog, and readiness inspection ship with this layer.
 * Agent Turns run `codex exec --json` unsandboxed, capture `thread_id` from
 * `thread.started` via `onSessionId` while the first turn is still running,
 * resume later turns with `codex exec resume`, and normalize the JSONL stream
 * into Session ID + ordered final assistant text (issue #557 / ADR 0041).
 */
export class Codex {
  static layer = (options: CodexLayerOptions = {}) =>
    Layer.effect(
      AgentBackend,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const binary = options.binary ?? DEFAULT_BINARY
        const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
        const environment = makeCodexEnvironment()

        const inspect = Effect.fn("Codex.inspect")(function* (
          input: InspectInput,
        ) {
          // Real `codex login status` prints markers with eprintln! (stderr
          // only). Capture stderr, allow non-zero exit so "Not logged in"
          // (exit 1) keeps text for actionable ConfigError mapping.
          const result = yield* runCliCapture({
            spawner,
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
            return yield* new AgentBackendConfigError({
              message: CODEX_UNAUTHENTICATED_MESSAGE,
            })
          }
          if (status.kind === "failed") {
            // Non-zero without auth markers: not unauthenticated. Surface
            // exit code + probe text so Recheck/Unavailable copy stays useful
            // (ExitError has no message for formatInspectFailure).
            return yield* new AgentBackendConfigError({
              message: `Codex Build readiness probe failed (codex login status exit ${status.exitCode}): ${clipProbeOutput(statusOutput)}`,
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
              // ExitError has no message field (shared contract); keep the
              // stream-extracted reason in logs so harness diagnostics are not
              // a bare exit 1.
              yield* Effect.logWarning("Codex Build turn.failed", {
                sessionId: stream.threadId ?? input.sessionId,
                message: stream.turnFailedMessage ?? "Codex turn.failed",
              })
              return yield* new AgentBackendExitError({
                exitCode: 1,
                cwd: input.cwd,
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
              runTurn({
                ...input,
                sessionId: input.sessionId,
                resume: true,
              }),
          ),
        })
      }),
    )

  static layerForTests = () => Codex.layer({})
}
