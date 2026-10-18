const sanitizeSegment = (value: string): string => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned.length > 0 ? cleaned : "repo"
}

export const repositorySlug = (projectPath: string): string =>
  projectPath.split("/").map(sanitizeSegment).join("-")

/**
 * Stable, collision-resistant branch for one Work Item.
 * Issue origin encodes repository slug, issue number, and Work Item id.
 * A CI Repair Work Item uses a dedicated branch with no issue number.
 */
export const workItemBranchName = (input: {
  readonly projectPath: string
  readonly issueNumber: number
  readonly workItemId: string
  readonly origin?: "issue" | "ci_repair"
}): string => {
  const slug = repositorySlug(input.projectPath)
  if (input.origin === "ci_repair") {
    return `rfa/${slug}/ci-repair/${input.workItemId}`
  }
  return `rfa/${slug}/${input.issueNumber}/${input.workItemId}`
}
