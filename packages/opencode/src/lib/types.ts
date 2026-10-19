import type { Duration } from "effect"

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
   * Startup inactivity window forwarded to the shared CLI runner (default 90s).
   * Tests may shorten it.
   */
  readonly startupTimeout?: Duration.Input
}
