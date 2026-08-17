import type { Duration } from "effect"

export interface GrokLayerOptions {
  readonly binary?: string
  readonly defaultTimeout?: Duration.Input
  readonly startupTimeout?: Duration.Input
  readonly forceKillAfter?: Duration.Input
}

/** Installed CLI effort values advertised on every catalog model when global. */
export const GROK_DEFAULT_THINKING_LEVELS = ["high", "medium", "low"] as const

/** CLI-advertised effort values for grok-4.6 only. Other Grok models omit xhigh. */
export const GROK_4_6_THINKING_LEVELS = [
  "xhigh",
  "high",
  "medium",
  "low",
] as const
