import type { Duration } from "effect"
import type { OpencodeExplicitServer } from "./opencode-v2-client.js"
import type { OpencodeStartupProbe } from "./startup-activity.js"

export interface OpencodeLayerOptions {
  readonly binary?: string
  readonly defaultTimeout?: Duration.Input
  readonly keymaxxerMcpUrl?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  /**
   * Explicit OpenCode server. When set, agent turns and telemetry reads use
   * this URL. When omitted, both use local service discovery. Reads never
   * start the service. Ignored for operation routing when `dedicatedServer`
   * is set.
   */
  readonly server?: OpencodeExplicitServer
  /**
   * Harness-owned OpenCode server started because Keymaxxer is enabled.
   * Every operation, including model discovery, uses this server. There is
   * no fallback to the shared service.
   */
  readonly dedicatedServer?: {
    readonly baseUrl: string
    readonly password: string
    readonly headers: Readonly<Record<string, string>>
    /** Undefined when the owned server can still accept work. */
    readonly assertAvailable: () => string | undefined
  }
  /**
   * Keymaxxer is enabled but the owned server is not usable. Operations fail
   * with this message and do not contact the shared service.
   */
  readonly openCodeBlockedReason?: string
  /**
   * Optional OpenCode SQLite path used only by session-model reassertion.
   * Startup-activity detection does not read this path.
   */
  readonly startupActivityDbPath?: string
  /**
   * Test seam for startup-activity detection. Production probes the V2 API.
   */
  readonly startupActivityProbe?: OpencodeStartupProbe
  /**
   * Startup inactivity window forwarded to the shared CLI runner (default 90s).
   * Tests may shorten it.
   */
  readonly startupTimeout?: Duration.Input
}
