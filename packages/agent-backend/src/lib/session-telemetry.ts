import type { Effect } from "effect"
import { Context } from "effect"
import type { AgentBackendDescriptor } from "./types.js"

export type SessionTelemetryAvailability =
  | "available"
  | "missing"
  | "unavailable"
  | "unsupported"

export type SessionTelemetryModel = {
  readonly providerId: string
  readonly id: string
  readonly thinkingLevel: string | null
}

export type SessionTelemetryTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/**
 * Normalized Session Telemetry for GraphQL and UI. Backend label is always
 * present so operators can see provenance even when metrics are missing.
 */
export type SessionTelemetry = {
  readonly id: string
  readonly availability: SessionTelemetryAvailability
  readonly backend: AgentBackendDescriptor
  readonly model: SessionTelemetryModel | null
  readonly tokens: SessionTelemetryTokens | null
  readonly cost: number | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
}

/**
 * Optional backend-owned Session Telemetry provider. Adapters that declare
 * SessionTelemetry supported must implement this service.
 */
export class SessionTelemetryProvider extends Context.Service<
  SessionTelemetryProvider,
  {
    readonly getSession: (
      sessionId: string,
    ) => Effect.Effect<SessionTelemetry, never>
  }
>()("@ready-for-agent/agent-backend/SessionTelemetryProvider") {}

export const unsupportedSessionTelemetry = (
  sessionId: string,
  backend: AgentBackendDescriptor,
): SessionTelemetry => ({
  id: sessionId,
  availability: "unsupported",
  backend,
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})

export const missingSessionTelemetry = (
  sessionId: string,
  backend: AgentBackendDescriptor,
): SessionTelemetry => ({
  id: sessionId,
  availability: "missing",
  backend,
  model: null,
  tokens: null,
  cost: null,
  createdAt: null,
  updatedAt: null,
})
