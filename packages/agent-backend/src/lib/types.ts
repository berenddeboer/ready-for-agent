import type { Duration, Effect } from "effect"

/** Stable built-in Agent Backend identifiers. */
export const AGENT_BACKEND_IDS = {
  opencode: "opencode",
  grok: "grok",
} as const

export type AgentBackendId =
  (typeof AGENT_BACKEND_IDS)[keyof typeof AGENT_BACKEND_IDS]

export interface AgentBackendDescriptor {
  readonly id: AgentBackendId
  readonly label: string
}

/** One Agent Model in the Active Agent Backend catalog. */
export interface AgentModel {
  readonly id: string
  readonly thinkingLevels: ReadonlyArray<string>
}

/**
 * Optional observer invoked with the first non-empty Session ID while the
 * Agent Turn process is still running. Failures must not fail the turn.
 */
export type OnSessionId = (
  sessionId: string,
) => Effect.Effect<void, unknown, never>

export interface InspectInput {
  readonly cwd: string
  readonly timeout?: Duration.Input
}

export interface InspectResult {
  readonly backend: AgentBackendDescriptor
  readonly models: ReadonlyArray<AgentModel>
}

export interface AgentTurnResult {
  readonly sessionId: string
  readonly assistantText: string
}

export interface StartTurnInput {
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  /** Null uses the backend/model default Thinking Level. */
  readonly thinkingLevel: string | null
  readonly timeout?: Duration.Input
  readonly onSessionId?: OnSessionId
  readonly command?: string
}

export interface ContinueTurnInput {
  readonly sessionId: string
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  readonly thinkingLevel: string | null
  readonly timeout?: Duration.Input
  readonly onSessionId?: OnSessionId
  readonly command?: string
}

/** Optional capability declarations for later Work Item-keyed routing. */
export type AgentBackendCapability =
  | { readonly _tag: "SessionTelemetry"; readonly supported: true }
  | { readonly _tag: "SessionTelemetry"; readonly supported: false }
  | { readonly _tag: "KeymaxxerMcp"; readonly supported: boolean }
