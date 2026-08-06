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
import { makeClaudeEnvironment } from "./environment.js"
import { parseClaudeAuthStatus } from "./parse-auth-status.js"
import {
  claudeAssistantText,
  createClaudeStreamParseState,
  foldClaudeStreamLine,
  isSuccessfulClaudeTurn,
} from "./parse-stream.js"
import { claudeProviderIdentity } from "./provider-identity.js"
import {
  CLAUDE_BEDROCK_UNAVAILABLE_MESSAGE,
  CLAUDE_STATIC_CATALOG,
  CLAUDE_UNAUTHENTICATED_MESSAGE,
  type ClaudeLayerOptions,
} from "./types.js"

const DEFAULT_TIMEOUT = Duration.minutes(30)
const DEFAULT_BINARY = "claude"

const CLAUDE_BACKEND = {
  id: AGENT_BACKEND_IDS.claude,
  label: "Claude Code",
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
 * Claude Code adapter implementing the backend-neutral AgentBackend contract.
 *
 * Static catalog and readiness inspection ship with this layer. Agent Turns
 * run `claude -p` with stream-json, preassign a Session UUID via
 * `--session-id` (reported through `onSessionId` while the first turn runs),
 * resume later turns with `--resume`, and normalize the JSONL stream into
 * Session ID + ordered final assistant text (issue #778 / ADR 0047).
 */
export class Claude {
  static layer = (options: ClaudeLayerOptions = {}) =>
    Layer.effect(
      AgentBackend,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const binary = options.binary ?? DEFAULT_BINARY
        const defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT
        const environment = makeClaudeEnvironment(
          options.environment !== undefined
            ? { environment: options.environment }
            : {},
        )

        const inspect = Effect.fn("Claude.inspect")(function* (
          input: InspectInput,
        ) {
          // Real `claude auth status` defaults to JSON on stdout. Capture both
          // streams and allow non-zero exit so unauthenticated states keep
          // text for actionable ConfigError mapping.
          const result = yield* runCliCapture({
            spawner,
            binary,
            args: ["auth", "status"],
            cwd: input.cwd,
            env: environment,
            timeout: input.timeout ?? defaultTimeout,
            allowNonZeroExit: true,
            captureStderr: true,
          })

          const statusOutput = [result.stdout, result.stderr]
            .filter((part) => part.length > 0)
            .join("\n")
          const status = parseClaudeAuthStatus(statusOutput, result.exitCode)
          if (status.kind === "unauthenticated") {
            // Bedrock third-party unusable readiness must not point at
            // `claude auth login` / first-party API key alone (#802).
            // Attach provider when known so Status/Preview can show
            // "Claude Code · Amazon Bedrock · Unavailable" on first failure (#819).
            const provider = claudeProviderIdentity(status.provider)
            return yield* new AgentBackendConfigError({
              message:
                status.provider === "bedrock"
                  ? CLAUDE_BEDROCK_UNAVAILABLE_MESSAGE
                  : CLAUDE_UNAUTHENTICATED_MESSAGE,
              ...(provider !== null ? { provider } : {}),
            })
          }
          if (status.kind === "failed") {
            return yield* new AgentBackendConfigError({
              message: `Claude Code readiness probe failed (claude auth status exit ${status.exitCode}): ${clipProbeOutput(statusOutput)}`,
            })
          }
          if (status.kind === "malformed") {
            return yield* malformedOutput(input.cwd, statusOutput)
          }

          // Provider identity travels with inspect so Active status, Preview,
          // and Recheck can present Bedrock vs first-party without re-deriving
          // it from process env (issue #819).
          return {
            backend: CLAUDE_BACKEND,
            models: CLAUDE_STATIC_CATALOG.map((model) => ({
              id: model.id,
              thinkingLevels: [...model.thinkingLevels],
            })),
            provider: claudeProviderIdentity(status.provider),
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
            // Preassigned Session ID is durable before the process exits
            // (ADR 0031 / 0047). Report it while the first turn is still running.
            if (!input.resume && input.onSessionId !== undefined) {
              yield* input.onSessionId(input.sessionId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Claude onSessionId observer failed", {
                    sessionId: input.sessionId,
                    error,
                  }),
                ),
              )
            }

            const args = buildRunArgs({
              prompt: input.prompt,
              model: input.model,
              thinkingLevel: input.thinkingLevel,
              ...(input.resume
                ? { resumeSessionId: input.sessionId }
                : { sessionId: input.sessionId }),
              ...(input.command !== undefined
                ? { command: input.command }
                : {}),
            })

            let stream = createClaudeStreamParseState()

            const turn = yield* runCliTurn({
              spawner,
              binary,
              args,
              cwd: input.cwd,
              env: environment,
              timeout: input.timeout ?? defaultTimeout,
              knownSessionId: input.sessionId,
              observerLabel: "Claude Code",
              parseLine: (line) => {
                stream = foldClaudeStreamLine(stream, line)

                if (stream.malformedLine) {
                  return {}
                }
                if (stream.resultSeen && stream.isError) {
                  return {
                    sessionId: stream.sessionId ?? input.sessionId,
                  }
                }
                if (stream.resultSeen && isSuccessfulClaudeTurn(stream)) {
                  return {
                    sessionId: stream.sessionId ?? input.sessionId,
                    finalizeText: claudeAssistantText(stream),
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
            if (stream.resultSeen && stream.isError) {
              yield* Effect.logWarning("Claude Code turn result is_error", {
                sessionId: input.sessionId,
                message: stream.errorMessage ?? "Claude Code turn failed",
              })
              return yield* new AgentBackendExitError({
                exitCode: 1,
                cwd: input.cwd,
                sessionId: input.sessionId,
              })
            }
            if (!stream.resultSeen || !isSuccessfulClaudeTurn(stream)) {
              return yield* malformedOutput(
                input.cwd,
                "(missing or unsuccessful terminal result event)",
              )
            }
            if (
              stream.sessionId !== undefined &&
              stream.sessionId !== input.sessionId
            ) {
              return yield* malformedOutput(
                input.cwd,
                `(session id mismatch: expected ${input.sessionId}, got ${stream.sessionId})`,
              )
            }

            return {
              sessionId: input.sessionId,
              assistantText: turn.assistantText,
            }
          })

        return AgentBackend.of({
          inspect,
          startTurn: Effect.fn("Claude.startTurn")((input: StartTurnInput) =>
            runTurn({
              ...input,
              sessionId: randomUUID(),
              resume: false,
            }),
          ),
          continueTurn: Effect.fn("Claude.continueTurn")(
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

  static layerForTests = () => Claude.layer({})
}
