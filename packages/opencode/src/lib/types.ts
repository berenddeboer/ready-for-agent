import type { Duration } from "effect"

export interface OpencodeRunResult {
  readonly sessionId: string
  readonly assistantText: string
}

export interface ListModelsInput {
  readonly cwd: string
  readonly timeout?: Duration.Input
}

export interface StartInput {
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  readonly variant: string
  readonly timeout?: Duration.Input
}

export interface ContinueInput {
  readonly sessionId: string
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  readonly variant: string
  readonly timeout?: Duration.Input
}

export interface OpencodeLayerOptions {
  readonly binary?: string
  readonly defaultTimeout?: Duration.Input
  readonly keymaxxerMcpUrl: string
}
