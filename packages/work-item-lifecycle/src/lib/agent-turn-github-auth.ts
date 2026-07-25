import { Effect, Schema } from "effect"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  type AgentBackendRegistration,
  capabilitySupported,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"
import {
  CurrentCapturedAgentBackendId,
  CurrentStepRun,
} from "./agent-turn-limiter.js"

/**
 * Effective Agent Turn GitHub auth: vault-backed only when the Active Agent
 * Backend supports KeymaxxerMcp and Keymaxxer is enabled for that instance.
 */
export type AgentTurnGitHubAuth =
  | { readonly _tag: "keymaxxer"; readonly tokenName: string }
  | { readonly _tag: "ambient" }

export class AgentTurnGitHubCredentialMissingError extends Schema.TaggedErrorClass<AgentTurnGitHubCredentialMissingError>()(
  "AgentTurnGitHubCredentialMissingError",
  {
    message: Schema.String,
  },
) {}

/**
 * Captured Agent Backend is missing or not selectable while a Step Run needs
 * it. Fail closed rather than falling back to the process-wide Active
 * registration.
 */
export class InvalidCapturedAgentBackendError extends Schema.TaggedErrorClass<InvalidCapturedAgentBackendError>()(
  "InvalidCapturedAgentBackendError",
  {
    message: Schema.String,
    /** Empty string when ambient capture was null on an in-flight Step Run. */
    backendId: Schema.String,
  },
) {}

export const isAgentTurnKeymaxxerEffective = (
  keymaxxerMcpSupported: boolean,
  keymaxxerEnabled: boolean | undefined,
): boolean => keymaxxerMcpSupported && keymaxxerEnabled !== false

export const resolveAgentTurnGitHubAuth = (input: {
  readonly githubOwner: string
  readonly githubRepo: string
}) =>
  Effect.gen(function* () {
    const active = yield* ActiveAgentBackend
    // Prefer the Work Item's captured backend when a Step Run is in flight.
    // Fail closed: non-selectable capture, or null capture while a Step Run is
    // ambient (mirrors LifecycleStepsLive routing — no silent proxy fallback).
    const captured = yield* CurrentCapturedAgentBackendId
    const registration: AgentBackendRegistration = yield* (() => {
      if (captured === null) {
        return Effect.gen(function* () {
          const stepRun = yield* CurrentStepRun
          if (stepRun !== null) {
            return yield* new InvalidCapturedAgentBackendError({
              message:
                "Work Item captured Agent Backend is missing on an in-flight Step Run",
              backendId: "",
            })
          }
          return yield* active.getActiveRegistration
        })
      }
      if (!isSelectableAgentBackendId(captured)) {
        return Effect.fail(
          new InvalidCapturedAgentBackendError({
            message: `Work Item captured Agent Backend is not selectable: ${captured}`,
            backendId: captured,
          }),
        )
      }
      return active.getRegistration(captured as AgentBackendId)
    })()
    const keymaxxer = yield* KeymaxxerService
    const effective = isAgentTurnKeymaxxerEffective(
      capabilitySupported(registration, "KeymaxxerMcp"),
      keymaxxer.enabled,
    )
    if (!effective) {
      return { _tag: "ambient" } satisfies AgentTurnGitHubAuth
    }
    const tokenName = yield* keymaxxer.findSecret({
      provider: "github",
      account: `${input.githubOwner}/${input.githubRepo}`,
    })
    if (tokenName === null) {
      return yield* new AgentTurnGitHubCredentialMissingError({
        message: `No GitHub credential is configured for ${input.githubOwner}/${input.githubRepo}`,
      })
    }
    return {
      _tag: "keymaxxer",
      tokenName,
    } satisfies AgentTurnGitHubAuth
  })

/**
 * Credential guidance line for Agent Turn prompts. Always included so ambient
 * backends get explicit `gh` instructions without Keymaxxer wording.
 */
export const agentTurnGitHubCredentialGuidance = (
  auth: AgentTurnGitHubAuth,
  accessScope: string,
): string => {
  switch (auth._tag) {
    case "keymaxxer":
      return `Use Keymaxxer secret ${auth.tokenName} via keymaxxer_run for any ${accessScope}; never put secret values in the environment.`
    case "ambient":
      return `Use the gh CLI with the existing ambient authentication for any ${accessScope}.`
  }
}
