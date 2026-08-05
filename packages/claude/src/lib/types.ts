import type { Duration } from "effect"
import type { AgentModel } from "@ready-for-agent/agent-backend"

export interface ClaudeLayerOptions {
  readonly binary?: string
  readonly defaultTimeout?: Duration.Input
  /**
   * Override process environment for Claude inspect/turn spawns (tests).
   * Production omits this so the harness process env is inherited.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>
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
 * Adapter-bundled static model catalog for Claude Code (ADR 0047).
 *
 * Floating aliases only; Anthropic resolves each alias. Excludes `default`,
 * `best`, `opusplan`, and context-window variants such as `sonnet[1m]`.
 */
export const CLAUDE_STATIC_CATALOG: ReadonlyArray<AgentModel> = [
  { id: "haiku", thinkingLevels: [...CLAUDE_THINKING_LEVELS] },
  { id: "sonnet", thinkingLevels: [...CLAUDE_THINKING_LEVELS] },
  { id: "opus", thinkingLevels: [...CLAUDE_THINKING_LEVELS] },
  { id: "fable", thinkingLevels: [...CLAUDE_THINKING_LEVELS] },
]
