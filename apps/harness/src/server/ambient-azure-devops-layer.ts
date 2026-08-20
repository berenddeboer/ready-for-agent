import { Layer } from "effect"
import {
  AZURE_DEVOPS_PAT_ENV_VAR,
  AzureDevOpsService,
  makeAzureDevOpsService,
} from "@ready-for-agent/azure-devops-service"

/**
 * Ambient-only Azure DevOps service layer: reads `AZURE_DEVOPS_EXT_PAT` from
 * the provided environment (or `process.env`) at layer-build time.
 *
 * Unlike GitHub/GitLab there is no vault-first Keymaxxer wiring yet (a later
 * ticket extends `keymaxxer-github-layer.ts`/`keymaxxer-gitlab-layer.ts`'s
 * pattern to Azure DevOps) and no CLI-tool fallback — there is no `az`
 * shellout convention in this codebase, unlike GitHub's `gh` or GitLab's
 * `glab`. A missing PAT means unauthenticated requests, which fail at call
 * time rather than at startup, so harness boot never depends on Azure DevOps
 * credentials being configured.
 *
 * The token is omitted entirely (not passed as `""`) when unset so
 * `hasCredentials`/`hasAmbientCredentials` correctly report `false` —
 * `makeAzureDevOpsServiceFromToken` always requires a `string` and treats
 * even an empty one as "a token was supplied" (see its own test suite), which
 * would otherwise make this layer always report credentials as present.
 */
export const ambientAzureDevOpsLayer = (
  environment: Partial<Record<string, string | undefined>> = process.env,
): Layer.Layer<AzureDevOpsService> => {
  const token = environment[AZURE_DEVOPS_PAT_ENV_VAR]?.trim()
  return Layer.succeed(
    AzureDevOpsService,
    makeAzureDevOpsService(
      token === undefined || token === "" ? {} : { token },
    ),
  )
}
