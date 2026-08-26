import { Layer } from "effect"
import {
  AZURE_DEVOPS_PAT_ENV_VAR,
  AzureDevOpsService,
  type AzureDevOpsServiceShape,
  makeAzureDevOpsService,
  makeAzureDevOpsServiceFromToken,
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
 * reports `false` rather than throwing. When Keymaxxer is enabled the
 * vault-first sibling (`keymaxxer-azure-devops-layer.ts`) wraps this as
 * the ambient fallback.
 */
export const ambientAzureDevOpsLayer = (options: {
  readonly environment?: Partial<Record<string, string | undefined>>
  readonly makeService?: (token: string) => AzureDevOpsServiceShape
  readonly makeAnonymousService?: () => AzureDevOpsServiceShape
}): Layer.Layer<AzureDevOpsService> => {
  const token = options.environment?.[AZURE_DEVOPS_PAT_ENV_VAR]?.trim()
  const makeService = options.makeService ?? makeAzureDevOpsServiceFromToken
  const makeAnonymousService =
    options.makeAnonymousService ?? (() => makeAzureDevOpsService({}))
  return Layer.succeed(
    AzureDevOpsService,
    token === undefined || token === ""
      ? makeAnonymousService()
      : makeService(token),
  )
}
