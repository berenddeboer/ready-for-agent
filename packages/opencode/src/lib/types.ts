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
   * start the service.
   */
  readonly server?: OpencodeExplicitServer
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
