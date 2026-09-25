import type { Forge } from "./generated/forge.js"

/**
 * How a `hierarchySupported: false` observation is interpreted.
 *
 * `required` is GitHub: false is a missing or failed hierarchy observation
 * and never falls back to flat-Issue rules.
 * `expected_unsupported` is GitLab and Azure DevOps: those Forges do not
 * query native sub-Issue hierarchy, so false is expected and the flat-Issue
 * rules apply.
 */
export type HierarchyObservationPolicy =
  | { readonly kind: "required" }
  | { readonly kind: "expected_unsupported" }

/**
 * Whether an open draft Issue-closing PR counts as an active closing PR.
 *
 * `active` is GitLab: an open draft still affects relevance.
 * `inactive` is GitHub and Azure DevOps: drafts do not affect relevance.
 */
export type OpenDraftClosingPullRequestPolicy =
  | { readonly kind: "active" }
  | { readonly kind: "inactive" }

/**
 * Existing hierarchy-fallback and draft-closing-PR treatment for one Forge.
 * Decision logic consumes these facts; it does not inspect the Forge name.
 */
export interface ForgeRelevancePolicy {
  readonly hierarchyObservation: HierarchyObservationPolicy
  readonly openDraftClosingPullRequest: OpenDraftClosingPullRequestPolicy
}

/**
 * Single mapping of the current three Forges onto the relevance policy
 * facts. A new Forge kind fails compilation here instead of inheriting a
 * default.
 */
export const relevancePolicyForForge = (forge: Forge): ForgeRelevancePolicy => {
  switch (forge) {
    case "github":
      return {
        hierarchyObservation: { kind: "required" },
        openDraftClosingPullRequest: { kind: "inactive" },
      }
    case "gitlab":
      return {
        hierarchyObservation: { kind: "expected_unsupported" },
        openDraftClosingPullRequest: { kind: "active" },
      }
    case "azure-devops":
      return {
        hierarchyObservation: { kind: "expected_unsupported" },
        openDraftClosingPullRequest: { kind: "inactive" },
      }
    default: {
      const _exhaustive: never = forge
      return _exhaustive
    }
  }
}
