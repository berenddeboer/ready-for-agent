import type { Duration, Effect } from "effect"

export interface OpencodeRunResult {
  readonly sessionId: string
  readonly assistantText: string
}

export interface ListModelsInput {
  readonly cwd: string
  readonly timeout?: Duration.Input
}

/**
 * Optional observer invoked with the first non-empty sessionID parsed from
 * OpenCode stdout while the process is still running. Failures must not fail
 * the run; the OpenCode client catches and logs them.
 */
export type OnSessionId = (
  sessionId: string,
) => Effect.Effect<void, unknown, never>

export interface StartInput {
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  readonly variant: string
  readonly timeout?: Duration.Input
  readonly onSessionId?: OnSessionId
}

export interface ContinueInput {
  readonly sessionId: string
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  readonly variant: string
  readonly timeout?: Duration.Input
  readonly onSessionId?: OnSessionId
}

export interface OpencodeLayerOptions {
  readonly binary?: string
  readonly defaultTimeout?: Duration.Input
  readonly keymaxxerMcpUrl: string
}
