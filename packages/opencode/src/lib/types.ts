import type { Duration } from "effect"

/** One OpenCode model id with its supported thinking-level (variant) keys. */
export interface OpencodeModel {
  readonly id: string
  readonly variants: ReadonlyArray<string>
}

export interface OpencodeLayerOptions {
  readonly binary?: string
  readonly defaultTimeout?: Duration.Input
  readonly keymaxxerMcpUrl?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  /**
   * Optional OpenCode SQLite path used only for startup-activity probes
   * (task subagent progress while the parent JSONL stream is silent).
   * Production resolves via `opencode db path` / path rules when omitted.
   */
  readonly startupActivityDbPath?: string
  /**
   * Startup inactivity window forwarded to the shared CLI runner (default 60s).
   * Tests may shorten it.
   */
  readonly startupTimeout?: Duration.Input
}
