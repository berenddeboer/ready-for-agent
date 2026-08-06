import type { Duration, Effect } from "effect"
import type { AgentModel } from "@ready-for-agent/agent-backend"

/**
 * Injectable Bedrock catalog discovery result (issue #820).
 * Defined here to avoid a cycle with the AWS SDK discovery module.
 */
export type ClaudeBedrockDiscoveryResult = {
  readonly models: ReadonlyArray<AgentModel>
  readonly warning: string | null
}

export type ClaudeDiscoverBedrockModels = (input: {
  readonly environment: Readonly<Record<string, string | undefined>>
  /**
   * Bound for the AWS control-plane list. Defaults in the production
   * discoverer; inspect passes the InspectInput timeout so Activate /
   * Recheck / Preview cannot hang on a stalled Bedrock API.
   */
  readonly timeout?: Duration.Input
}) => Effect.Effect<ClaudeBedrockDiscoveryResult>

export interface ClaudeLayerOptions {
  readonly binary?: string
  readonly defaultTimeout?: Duration.Input
  /**
   * Override process environment for Claude inspect/turn spawns (tests).
   * Production omits this so the harness process env is inherited.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /**
   * Injectable Bedrock inference-profile discovery (issue #820). Production
   * defaults to the AWS SDK ListInferenceProfiles path. Tests inject a fake
   * so inspect proves catalog/warning behavior without live AWS.
   */
  readonly discoverBedrockModels?: ClaudeDiscoverBedrockModels
}

/**
 * Actionable readiness-failure copy when `claude auth status` reports no auth.
 * Operators may use Claude.ai OAuth (`claude auth login`) or an API key.
 */
export const CLAUDE_UNAUTHENTICATED_MESSAGE =
  "Claude Code is not authenticated. Run `claude auth login` (or set `ANTHROPIC_API_KEY`), then Recheck Agent Backend."

/**
 * Actionable readiness-failure copy when Claude reports Amazon Bedrock as the
 * provider but readiness is unusable (credentials, region, or probe failure).
 * Primary action is AWS credentials/region — this path already implies Bedrock
 * mode — not first-party login (issue #802 / epic #799).
 */
export const CLAUDE_BEDROCK_UNAVAILABLE_MESSAGE =
  "Claude Code Amazon Bedrock is not ready. Ensure valid AWS credentials and region are available to the harness process (with CLAUDE_CODE_USE_BEDROCK=1), then Recheck Agent Backend."

/** Official Thinking Levels for Claude Code v1 (ADR 0047). No `ultracode`. */
export const CLAUDE_THINKING_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

/**
 * Adapter-bundled static model catalog for first-party Claude Code (ADR 0047).
 *
 * Floating aliases only; Anthropic resolves each alias. Excludes `default`,
 * `best`, `opusplan`, and context-window variants such as `sonnet[1m]`.
 * Amazon Bedrock mode replaces this catalog with AWS-discovered inference
 * profile IDs (issue #820); aliases are not offered while Bedrock is active.
 */
export const CLAUDE_STATIC_CATALOG: ReadonlyArray<AgentModel> = [
  { id: "haiku", thinkingLevels: [...CLAUDE_THINKING_LEVELS] },
  { id: "sonnet", thinkingLevels: [...CLAUDE_THINKING_LEVELS] },
  { id: "opus", thinkingLevels: [...CLAUDE_THINKING_LEVELS] },
  { id: "fable", thinkingLevels: [...CLAUDE_THINKING_LEVELS] },
]

/** Floating aliases excluded from the Bedrock-mode catalog (issue #820). */
export const CLAUDE_FLOATING_ALIAS_IDS = [
  "haiku",
  "sonnet",
  "opus",
  "fable",
] as const
