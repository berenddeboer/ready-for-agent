import type { Effect } from "effect"
import { Schema } from "effect"
import type { AcpClientError } from "./errors.js"

export const AcpSessionId = Schema.String.pipe(Schema.brand("AcpSessionId"))
export type AcpSessionId = typeof AcpSessionId.Type

export type AcpMeta = { readonly [key: string]: unknown }

export const AcpStopReason = Schema.Literals([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
])
export type AcpStopReason = typeof AcpStopReason.Type

export type AcpConnectInput = {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
}

export type AcpInitializeInput = {
  readonly _meta?: AcpMeta
}

export type AcpAuthMethod = {
  readonly id: string
  readonly name: string
}

export type AcpInitializeResult = {
  readonly protocolVersion: number
  readonly loadSession: boolean
  readonly resume: boolean
  readonly authMethods: readonly AcpAuthMethod[]
  readonly _meta?: AcpMeta
}

export type AcpAuthenticateInput = {
  readonly methodId: string
  readonly _meta?: AcpMeta
}

export type AcpNewSessionInput = {
  readonly cwd: string
  readonly _meta?: AcpMeta
}

export type AcpLoadSessionInput = {
  readonly sessionId: AcpSessionId
  readonly cwd: string
  readonly _meta?: AcpMeta
}

export type AcpResumeSessionInput = {
  readonly sessionId: AcpSessionId
  readonly cwd: string
  readonly _meta?: AcpMeta
}

export type AcpSessionResult = {
  readonly sessionId: AcpSessionId
  readonly _meta?: AcpMeta
}

export type AcpPromptInput = {
  readonly sessionId: AcpSessionId
  readonly prompt: string
  readonly _meta?: AcpMeta
}

export type AcpPromptResult = {
  readonly sessionId: AcpSessionId
  readonly assistantText: string
  readonly stopReason: AcpStopReason
  readonly _meta?: AcpMeta
}

export type AcpCancelInput = {
  readonly sessionId: AcpSessionId
  readonly _meta?: AcpMeta
}

export type AcpConnection = {
  readonly pid: number
  readonly initialize: (
    input?: AcpInitializeInput,
  ) => Effect.Effect<AcpInitializeResult, AcpClientError>
  readonly authenticate: (
    input: AcpAuthenticateInput,
  ) => Effect.Effect<void, AcpClientError>
  readonly newSession: (
    input: AcpNewSessionInput,
  ) => Effect.Effect<AcpSessionResult, AcpClientError>
  readonly loadSession: (
    input: AcpLoadSessionInput,
  ) => Effect.Effect<AcpSessionResult, AcpClientError>
  readonly resumeSession: (
    input: AcpResumeSessionInput,
  ) => Effect.Effect<AcpSessionResult, AcpClientError>
  readonly prompt: (
    input: AcpPromptInput,
  ) => Effect.Effect<AcpPromptResult, AcpClientError>
  readonly cancel: (
    input: AcpCancelInput,
  ) => Effect.Effect<void, AcpClientError>
}
