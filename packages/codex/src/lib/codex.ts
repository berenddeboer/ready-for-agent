import { Duration, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  AGENT_BACKEND_IDS,
  AgentBackend,
  AgentBackendConfigError,
  type ContinueTurnInput,
  type InspectInput,
  type StartTurnInput,
  malformedOutput,
  runCliCapture,
} from "@ready-for-agent/agent-backend"
import { makeCodexEnvironment } from "./environment.js"
import { parseCodexLoginStatus } from "./parse-login-status.js"
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
 * This package ships registration, static catalog, and readiness inspection
 * (issue #556). Agent Turns (start/continue) land in #557; until then they
 * fail with a clear config error so Preview/Recheck remain demoable without
 * turns.
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

        const turnsNotImplemented = (operation: string) =>
          new AgentBackendConfigError({
            message: `Codex Build Agent Turns are not available yet (${operation}).`,
          })

        return AgentBackend.of({
          inspect,
          startTurn: Effect.fn("Codex.startTurn")((_input: StartTurnInput) =>
            Effect.fail(turnsNotImplemented("startTurn")),
          ),
          continueTurn: Effect.fn("Codex.continueTurn")(
            (_input: ContinueTurnInput) =>
              Effect.fail(turnsNotImplemented("continueTurn")),
          ),
        })
      }),
    )

  static layerForTests = () => Codex.layer({})
}
