import { Layer } from "effect"
import {
  AZURE_DEVOPS_PAT_ENV_VAR,
  AzureDevOpsService,
  makeAzureDevOpsService,
} from "@ready-for-agent/azure-devops-service"

/**
 * Ambient Azure DevOps service layer for the Harness's own reads
 * (`listReadyIssues`, credential checks, etc.) — separate from
 * `agent-turn-forge-auth.ts`, which resolves credentials for *Agent Turn*
 * subprocesses.
 *
 * Unlike GitHub/GitLab, there is no CLI (`gh`/`glab`) to shell out to for
 * token discovery, and `AzureDevOpsServiceLive` (the package's own Live
 * layer) is not used directly here because it fails closed via
 * `Config.redacted` when the PAT env var is absent — which would break
 * Harness startup entirely for installs with no Azure DevOps Repository.
 * This layer instead reads the PAT from the same `environment` record the
 * ambient GitHub/GitLab layers already thread through (so tests can inject
 * it), tolerating an absent PAT the same way `hasCredentials` already
 * reports `false` rather than throwing. There is no Keymaxxer-vault variant
 * yet: the harness's own reads stay ambient-PAT only. Agent Turns are
 * unaffected — they resolve vault-first credentials with ambient fallback
 * through `agent-turn-forge-auth.ts`, not through this layer.
 */
export const ambientAzureDevOpsLayer = (options: {
  readonly environment?: Partial<Record<string, string | undefined>>
}): Layer.Layer<AzureDevOpsService> => {
  const token = options.environment?.[AZURE_DEVOPS_PAT_ENV_VAR]?.trim()
  return Layer.succeed(
    AzureDevOpsService,
    makeAzureDevOpsService(
      token === undefined || token === "" ? {} : { token },
    ),
  )
}
