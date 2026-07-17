export const workItemPullRequestUrl = (
  githubOwner: string,
  githubRepo: string,
  githubPullRequestNumber: number | null,
): string | null => {
  if (githubPullRequestNumber === null) return null
  return `https://github.com/${githubOwner}/${githubRepo}/pull/${githubPullRequestNumber}`
}
