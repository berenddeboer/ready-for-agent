export const workItemPullRequestUrl = (
  forgeHost: string,
  projectPath: string,
  pullRequestNumber: number | null,
): string | null => {
  if (pullRequestNumber === null) return null
  return `https://${forgeHost}/${projectPath}/pull/${pullRequestNumber}`
}
