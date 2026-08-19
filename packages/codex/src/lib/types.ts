import type { Duration } from "effect"
import type { AgentModel } from "@ready-for-agent/agent-backend"

export interface CodexLayerOptions {
  readonly binary?: string
  readonly defaultTimeout?: Duration.Input
  /**
   * Override process environment for Codex inspect/turn spawns (tests).
   * Production omits this so the harness process env is inherited.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>
}

/**
 * Actionable readiness-failure copy when `codex login status` reports no auth
 * and user-level config does not select a valid custom model provider.
 *
 * `codex login status` reads stored login only and ignores `OPENAI_API_KEY`,
 * so that env var is not offered as inspect remediation.
 */
export const CODEX_UNAUTHENTICATED_MESSAGE =
  "Codex Build is not authenticated. Run `codex login` to store ChatGPT or API-key credentials, or set `model_provider` to a custom provider in `~/.codex/config.toml`, then Recheck Agent Backend."

/**
 * Adapter-bundled static model catalog for Codex Build (ADR 0041).
 *
 * Only current-generation models (gpt-5.5 and up). Thinking Levels are the
 * Codex CLI `model_reasoning_effort` values each model supports. Pinned from
 * `codex debug models` for Codex CLI 0.145.x; update on Harness release when
 * OpenAI ships a new generation.
 */
export const CODEX_STATIC_CATALOG: ReadonlyArray<AgentModel> = [
  {
    id: "gpt-5.6-sol",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-terra",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-luna",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gpt-5.5",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
  },
]
