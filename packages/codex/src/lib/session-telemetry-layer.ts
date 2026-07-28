import { Effect, Layer } from "effect"
import {
  AGENT_BACKEND_IDS,
  SessionTelemetryProvider,
  unsupportedSessionTelemetry,
} from "@ready-for-agent/agent-backend"

const CODEX_BACKEND = {
  id: AGENT_BACKEND_IDS.codex,
  label: "Codex Build",
} as const

/**
 * Codex Build declares Session Telemetry unsupported (ADR 0041 v1).
 * Provides a provider that always reports `unsupported` so composition roots
 * can wire Codex like other backends without a null telemetry branch.
 *
 * Accepts an unused options bag so the export is a Layer factory matching
 * Grok/OpenCode call sites (`CodexSessionTelemetryLive()`).
 */
export const CodexSessionTelemetryLive = (
  _options: Record<string, never> = {},
): Layer.Layer<SessionTelemetryProvider> =>
  Layer.succeed(
    SessionTelemetryProvider,
    SessionTelemetryProvider.of({
      getSession: (sessionId) =>
        Effect.succeed(unsupportedSessionTelemetry(sessionId, CODEX_BACKEND)),
    }),
  )
