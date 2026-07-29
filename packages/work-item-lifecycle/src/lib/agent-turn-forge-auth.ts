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
 * Effective Agent Forge Access mode: vault-backed only when the Active Agent
 * Backend supports KeymaxxerMcp and Keymaxxer is enabled for that instance.
 */
export type AgentTurnForgeAuth =
  | { readonly _tag: "keymaxxer"; readonly tokenName: string }
  | { readonly _tag: "ambient" }

export type AgentTurnForgeRepository = {
  readonly forge: "github" | "gitlab"
  readonly forgeHost: string
  readonly projectPath: string
}

export class AgentTurnForgeCredentialMissingError extends Schema.TaggedErrorClass<AgentTurnForgeCredentialMissingError>()(
  "AgentTurnForgeCredentialMissingError",
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

const resolveAgentTurnKeymaxxerAuth = (input: {
  readonly provider: "github" | "gitlab"
  readonly account: string
  readonly credentialDescription: string
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
      return { _tag: "ambient" } satisfies AgentTurnForgeAuth
    }
    const tokenName = yield* keymaxxer.findSecret({
      provider: input.provider,
      account: input.account,
    })
    if (tokenName === null) {
      return yield* new AgentTurnForgeCredentialMissingError({
        message: `No ${input.credentialDescription} is configured for ${input.account}`,
      })
    }
    return {
      _tag: "keymaxxer",
      tokenName,
    } satisfies AgentTurnForgeAuth
  })

export const resolveAgentTurnGitHubAuth = (input: {
  readonly projectPath: string
}) =>
  resolveAgentTurnKeymaxxerAuth({
    provider: "github",
    account: input.projectPath,
    credentialDescription: "GitHub credential",
  })

/**
 * Resolve Agent Turn authentication at the Forge boundary.
 *
 * GitLab uses the Repository's Forge identity for named-secret lookup when
 * vault access is effective, otherwise ambient `GITLAB_TOKEN` or `glab`.
 */
export const resolveAgentTurnForgeAuth = (
  repository: AgentTurnForgeRepository,
) =>
  Effect.gen(function* () {
    if (repository.forge === "gitlab") {
      return yield* resolveAgentTurnKeymaxxerAuth({
        provider: "gitlab",
        account: `${repository.forgeHost}/${repository.projectPath}`,
        credentialDescription: "GitLab credential",
      })
    }
    return yield* resolveAgentTurnGitHubAuth({
      projectPath: repository.projectPath,
    })
  })

/**
 * Credential guidance line for Agent Turn prompts. Always included so ambient
 * backends get explicit `gh` instructions without Keymaxxer wording.
 */
export const agentTurnGitHubCredentialGuidance = (
  auth: AgentTurnForgeAuth,
  accessScope: string,
): string => {
  switch (auth._tag) {
    case "keymaxxer":
      return `Use Keymaxxer secret ${auth.tokenName} via keymaxxer_run for any ${accessScope}; never put secret values in the environment.`
    case "ambient":
      return `Use the gh CLI with the existing ambient authentication for any ${accessScope}.`
  }
}

/**
 * Forge-selected credential and tool guidance for lifecycle Agent Turns.
 * GitLab guidance deliberately offers REST curl and host-scoped glab, and
 * explicitly excludes gh so the Turn cannot silently target GitHub.
 */
export const agentTurnForgeCredentialGuidance = (
  repository: AgentTurnForgeRepository,
  auth: AgentTurnForgeAuth,
  accessScope: string,
): string => {
  if (repository.forge === "github") {
    return agentTurnGitHubCredentialGuidance(auth, accessScope)
  }
  if (auth._tag === "keymaxxer") {
    return [
      `For any ${accessScope}, use Keymaxxer secret ${auth.tokenName} via keymaxxer_run to run curl against the GitLab REST API at https://${repository.forgeHost}/api/v4.`,
      `Inside the injected command, read the token from $${auth.tokenName} and send it in a PRIVATE-TOKEN header; never put secret values in the ambient environment.`,
    ].join(" ")
  }
  return [
    `For any ${accessScope}, use curl against the GitLab REST API at https://${repository.forgeHost}/api/v4 with the Repository's ambient GITLAB_TOKEN credential in a PRIVATE-TOKEN header,`,
    `or use glab authenticated for ${repository.forgeHost}.`,
  ].join(" ")
}
