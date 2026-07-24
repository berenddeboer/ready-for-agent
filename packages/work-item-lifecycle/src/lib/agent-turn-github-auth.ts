import { Effect, Schema } from "effect"
import {
  ActiveAgentBackend,
  capabilitySupported,
} from "@ready-for-agent/agent-backend"
import { KeymaxxerService } from "@ready-for-agent/keymaxxer-service"

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
    const registration = yield* active.getActiveRegistration
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
