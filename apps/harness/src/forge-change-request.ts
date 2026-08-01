/**
 * Forge-specific names for GitHub pull requests vs GitLab merge requests.
 * Used on archive legs, PR badges, and aria-labels.
 */

export type ForgeId = "github" | "gitlab"

export function normalizeForge(forge: string | undefined | null): ForgeId {
  return forge === "gitlab" ? "gitlab" : "github"
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
