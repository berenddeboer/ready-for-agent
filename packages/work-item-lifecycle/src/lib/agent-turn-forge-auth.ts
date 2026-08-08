import { Duration, Effect, Schema } from "effect"
import {
  ActiveAgentBackend,
  type AgentBackendId,
  type AgentBackendRegistration,
  capabilitySupported,
  isSelectableAgentBackendId,
} from "@ready-for-agent/agent-backend"
import {
  GITLAB_VAULT_METADATA_BUDGET_SECONDS,
  gitlabVaultAccount,
} from "@ready-for-agent/gitlab-service"
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
  /**
   * When set, vault metadata is budgeted; miss/timeout/KeymaxxerError yields
   * ambient instead of fail-closed missing credential (GitLab policy).
   */
  readonly vaultMetadataBudget?: Duration.Duration
  readonly ambientOnVaultUnavailable?: boolean
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
    const lookup = keymaxxer.findSecret({
      provider: input.provider,
      account: input.account,
    })
    const tokenName =
      input.vaultMetadataBudget === undefined
        ? yield* lookup
        : yield* lookup.pipe(
            Effect.timeout(input.vaultMetadataBudget),
            Effect.catchTags({
              TimeoutError: () => Effect.succeed(null),
              KeymaxxerError: () => Effect.succeed(null),
            }),
          )
    if (tokenName === null) {
      if (input.ambientOnVaultUnavailable === true) {
        return { _tag: "ambient" } satisfies AgentTurnForgeAuth
      }
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
 * Keymaxxer vault account for a GitLab Repository (`<forge-host>/<project-path>`).
 * Same formatter as harness forge ops — re-export, not a parallel implementation.
 */
export const agentTurnGitLabVaultAccount = gitlabVaultAccount

/**
 * Vault metadata budget for GitLab Agent Turns before ambient fallback.
 * Shared constant with harness layer (`GITLAB_VAULT_METADATA_BUDGET_SECONDS`).
 */
export const AGENT_TURN_GITLAB_VAULT_METADATA_BUDGET = Duration.seconds(
  GITLAB_VAULT_METADATA_BUDGET_SECONDS,
)

/**
 * Resolve Agent Turn authentication at the Forge boundary.
 *
 * GitLab vault-first: when Keymaxxer MCP is effective and a per-Repository
 * secret exists (`provider: gitlab`, `account: <forge-host>/<project-path>`),
 * use `keymaxxer_run`. When no secret exists — or vault metadata times out /
 * errors — ambient `GITLAB_TOKEN` / `glab` remains the fallback (unlike
 * GitHub, which fails closed without a vault secret on Keymaxxer-capable
 * backends).
 */
export const resolveAgentTurnForgeAuth = (
  repository: AgentTurnForgeRepository,
  options?: {
    /** Override GitLab vault metadata budget (tests). */
    readonly gitlabVaultMetadataBudget?: Duration.Duration
  },
) =>
  Effect.gen(function* () {
    if (repository.forge === "gitlab") {
      return yield* resolveAgentTurnKeymaxxerAuth({
        provider: "gitlab",
        account: gitlabVaultAccount(repository),
        credentialDescription: "GitLab credential",
        vaultMetadataBudget:
          options?.gitlabVaultMetadataBudget ??
          AGENT_TURN_GITLAB_VAULT_METADATA_BUDGET,
        ambientOnVaultUnavailable: true,
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
 * GitLab guidance uses host-scoped glab and explicitly excludes the GitHub
 * CLI so the Turn cannot silently target the wrong Forge.
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
      `For any ${accessScope}, use Keymaxxer secret ${auth.tokenName} via keymaxxer_run to drive glab for https://${repository.forgeHost}/${repository.projectPath}.`,
      `On POSIX shells, pass a child command of the form \`GITLAB_TOKEN="$${auth.tokenName}" GITLAB_HOST="https://${repository.forgeHost}" glab <subcommand> ...\`.`,
      `On Windows cmd.exe, use \`set "GITLAB_TOKEN=%${auth.tokenName}%" && set "GITLAB_HOST=https://${repository.forgeHost}" && glab <subcommand> ...\`. Never put secret values in the ambient environment.`,
    ].join(" ")
  }
  return `For any ${accessScope}, use the glab CLI authenticated for ${repository.forgeHost} and target https://${repository.forgeHost}/${repository.projectPath}.`
}
