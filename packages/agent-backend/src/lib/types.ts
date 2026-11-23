import type { Duration, Effect } from "effect"
import type { InvocationReceipt } from "./invocation-ownership.js"

/** Stable built-in Agent Backend identifiers. */
export const AGENT_BACKEND_IDS = {
  opencode: "opencode",
  grok: "grok",
  codex: "codex",
  /** Claude Code adapter package (ADR 0047). */
  claude: "claude",
} as const

export type AgentBackendId =
  (typeof AGENT_BACKEND_IDS)[keyof typeof AGENT_BACKEND_IDS]

export interface AgentBackendDescriptor {
  readonly id: AgentBackendId
  readonly label: string
}

/**
 * Optional effective hosting provider for an Agent Backend (e.g. Claude Code
 * Amazon Bedrock vs first-party). Identity originates from the adapter's
 * inspect/auth probe — not from environment-flag inference alone.
 */
export interface AgentBackendProvider {
  /** Stable machine id (e.g. `bedrock`, `firstParty`). */
  readonly id: string
  /** Operator-facing label (e.g. `Amazon Bedrock`, `First-party`). */
  readonly label: string
}

/** One Agent Model in the Active Agent Backend catalog. */
export interface AgentModel {
  /** Executable Agent Model value passed to the backend (e.g. Claude `--model`). */
  readonly id: string
  readonly thinkingLevels: ReadonlyArray<string>
  /**
   * Optional operator-facing display name. Distinct from {@link id}: Settings
   * may show this while still persisting and executing `id` unchanged.
   * Omitted/null when the backend has no friendlier label than `id`.
   */
  readonly name?: string | null
  /**
   * Optional catalog kind metadata so Settings can distinguish entry types
   * without changing other Agent Backends (e.g. Bedrock `SYSTEM_DEFINED` vs
   * `APPLICATION`). Omitted/null when the backend does not classify entries.
   */
  readonly kind?: string | null
}

/**
 * Optional observer invoked with the first non-empty Session ID while the
 * Agent Turn process is still running. Failures must not fail the turn.
 */
export type OnSessionId = (
  sessionId: string,
) => Effect.Effect<void, unknown, never>

export interface AttachedImplementStop {
  readonly sessionId: string
  readonly serverKey: string
  /** Only set for a locally owned/service-discovered server. */
  readonly localPid?: number
}

export type PendingImplementStop =
  | AttachedImplementStop
  | {
      readonly sessionId: string
      readonly invocation: InvocationReceipt
    }

export interface TrackImplementStop {
  readonly started: (
    target: PendingImplementStop,
  ) => Effect.Effect<void, unknown>
  readonly stopped: (
    target: PendingImplementStop,
  ) => Effect.Effect<void, unknown>
}

export interface InspectInput {
  readonly cwd: string
  readonly timeout?: Duration.Input
}

export interface InspectResult {
  readonly backend: AgentBackendDescriptor
  readonly models: ReadonlyArray<AgentModel>
  /**
   * Effective hosting provider when the adapter reports one. Omitted or null
   * for backends that do not expose provider identity.
   */
  readonly provider?: AgentBackendProvider | null
  /**
   * Non-fatal operator-facing warnings from inspect (e.g. Bedrock profile
   * discovery failed while readiness remains Ready). Omitted or empty when
   * there is nothing to surface. Distinct from Unavailable `reason`.
   */
  readonly warnings?: ReadonlyArray<string>
}

export interface AgentTurnResult {
  readonly sessionId: string
  readonly assistantText: string
  /** Earlier assistant steps of the same prompt, when the reply is collected separately. */
  readonly precedingAssistantText?: string
}

export interface StartTurnInput {
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  /** Null uses the backend/model default Thinking Level. */
  readonly thinkingLevel: string | null
  readonly timeout?: Duration.Input
  readonly onSessionId?: OnSessionId
  /** Persist a stop obligation before submitting an Implement prompt. */
  readonly trackImplementStop?: TrackImplementStop
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
  readonly trackImplementStop?: TrackImplementStop
  readonly command?: string
  /** For a plain prompt, collect its reply rather than session-wide CLI output. */
  readonly replyToPromptOnly?: boolean
}

/** Optional capability declarations for later Work Item-keyed routing. */
export type AgentBackendCapability =
  | { readonly _tag: "SessionTelemetry"; readonly supported: true }
  | { readonly _tag: "SessionTelemetry"; readonly supported: false }
  | { readonly _tag: "AgentTurnTail"; readonly supported: true }
  | { readonly _tag: "AgentTurnTail"; readonly supported: false }
  | { readonly _tag: "KeymaxxerMcp"; readonly supported: boolean }
