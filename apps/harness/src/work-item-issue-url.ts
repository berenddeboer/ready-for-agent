export const workItemIssueUrl = (
  githubOwner: string,
  githubRepo: string,
  githubIssueNumber: number,
): string =>
  `https://github.com/${githubOwner}/${githubRepo}/issues/${githubIssueNumber}`
