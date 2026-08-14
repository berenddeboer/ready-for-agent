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
 * Encodes repository slug, issue number, and Work Item id.
 */
export const workItemBranchName = (input: {
  readonly projectPath: string
  readonly issueNumber: number
  readonly workItemId: string
}): string => {
  const slug = repositorySlug(input.projectPath)
  return `rfa/${slug}/${input.issueNumber}/${input.workItemId}`
}
