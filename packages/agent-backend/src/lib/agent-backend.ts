import type { Effect } from "effect"
import { Context } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type {
  AgentBackendConfigError,
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  AgentBackendSessionIdMissingError,
  AgentBackendTimeoutError,
} from "./errors.js"
import type {
  AgentTurnResult,
  ContinueTurnInput,
  InspectInput,
  InspectResult,
  StartTurnInput,
} from "./types.js"

export type AgentBackendError =
  | AgentBackendConfigError
  | AgentBackendExitError
  | AgentBackendTimeoutError
  | AgentBackendSessionIdMissingError
  | AgentBackendMalformedOutputError
  | PlatformError

/**
 * Backend-neutral Agent Backend service: atomic inspection and Agent Turns.
 */
export class AgentBackend extends Context.Service<
  AgentBackend,
  {
    readonly inspect: (
      input: InspectInput,
    ) => Effect.Effect<InspectResult, AgentBackendError>
    readonly startTurn: (
      input: StartTurnInput,
    ) => Effect.Effect<AgentTurnResult, AgentBackendError>
    readonly continueTurn: (
      input: ContinueTurnInput,
    ) => Effect.Effect<AgentTurnResult, AgentBackendError>
  }
>()("@ready-for-agent/agent-backend/AgentBackend") {}
