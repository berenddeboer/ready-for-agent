export const workItemPullRequestUrl = (
  forge: string,
  forgeHost: string,
  projectPath: string,
  pullRequestNumber: number | null,
): string | null => {
  if (pullRequestNumber === null) return null
  return forge === "gitlab"
    ? `https://${forgeHost}/${projectPath}/-/merge_requests/${pullRequestNumber}`
    : `https://${forgeHost}/${projectPath}/pull/${pullRequestNumber}`
}
