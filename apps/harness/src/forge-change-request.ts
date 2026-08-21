/**
 * Forge-specific names for GitHub pull requests vs GitLab merge requests.
 * Used on archive legs, PR badges, and aria-labels.
 */

export type ForgeId = "github" | "gitlab" | "azure-devops"

/**
 * Azure DevOps uses GitHub's "pull request" terminology, so it maps onto the
 * "PR" branch; the exhaustive mapping exists so a new Forge fails here instead
 * of silently inheriting the wrong noun.
 */
export function normalizeForge(forge: string | undefined | null): ForgeId {
  switch (forge) {
    case "gitlab":
      return "gitlab"
    case "azure-devops":
      return "azure-devops"
    default:
      return "github"
  }
}

/** Compact chip / badge token: "PR" (GitHub) or "MR" (GitLab). */
export function forgeChangeRequestShort(
  forge: string | undefined | null,
): string {
  return normalizeForge(forge) === "gitlab" ? "MR" : "PR"
}

/** Full noun for accessible labels: "pull request" / "merge request". */
export function forgeChangeRequestNoun(
  forge: string | undefined | null,
): string {
  return normalizeForge(forge) === "gitlab" ? "merge request" : "pull request"
}
