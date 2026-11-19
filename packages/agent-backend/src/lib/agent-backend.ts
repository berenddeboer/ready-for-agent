import type { Effect } from "effect"
import { Context } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type {
  AgentBackendConfigError,
  AgentBackendExitError,
  AgentBackendMalformedOutputError,
  AgentBackendNotInstalledError,
  AgentBackendSessionIdMissingError,
  AgentBackendStartupTimeoutError,
  AgentBackendTimeoutError,
} from "./errors.js"
import type {
  AgentTurnResult,
  ContinueTurnInput,
  InspectInput,
  InspectResult,
  PendingImplementStop,
  StartTurnInput,
} from "./types.js"

export type AgentBackendError =
  | AgentBackendConfigError
  | AgentBackendExitError
  | AgentBackendTimeoutError
  | AgentBackendStartupTimeoutError
  | AgentBackendSessionIdMissingError
  | AgentBackendMalformedOutputError
  | AgentBackendNotInstalledError
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
    /** Recover only the recorded invocation or verify the original attached session. */
    readonly verifyImplementStopped?: (
      input: PendingImplementStop & { readonly cwd: string },
    ) => Effect.Effect<void, AgentBackendError>
  }
>()("@ready-for-agent/agent-backend/AgentBackend") {}
