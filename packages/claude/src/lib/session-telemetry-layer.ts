import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  SessionTelemetryProvider,
  unsupportedSessionTelemetry,
} from "@ready-for-agent/agent-backend"

const CLAUDE_BACKEND = {
  id: AGENT_BACKEND_IDS.claude,
  label: "Claude Code",
} as const

/**
 * Claude Code declares Session Telemetry unsupported (ADR 0047 v1).
 * Provides a provider that always reports `unsupported` so composition roots
 * can wire Claude like other backends without a null telemetry branch.
 *
 * Accepts an unused options bag so the export is a Layer factory matching
 * Grok/Codex call sites (`ClaudeSessionTelemetryLive()`).
 */
export const ClaudeSessionTelemetryLive = (
  _options: Record<string, never> = {},
): Layer.Layer<SessionTelemetryProvider> =>
  Layer.succeed(
    SessionTelemetryProvider,
    SessionTelemetryProvider.of({
      getSession: (sessionId) =>
        Effect.succeed(unsupportedSessionTelemetry(sessionId, CLAUDE_BACKEND)),
    }),
  )
