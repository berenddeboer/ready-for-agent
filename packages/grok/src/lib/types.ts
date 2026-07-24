import type { Duration } from "effect"

export interface GrokLayerOptions {
  readonly binary?: string
  readonly defaultTimeout?: Duration.Input
}

/** Installed CLI effort values advertised on every catalog model when global. */
export const GROK_DEFAULT_THINKING_LEVELS = ["high", "medium", "low"] as const
