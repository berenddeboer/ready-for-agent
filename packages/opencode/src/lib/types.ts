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
}
