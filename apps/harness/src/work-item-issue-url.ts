export const workItemIssueUrl = (
  forgeHost: string,
  projectPath: string,
  issueNumber: number,
): string => `https://${forgeHost}/${projectPath}/issues/${issueNumber}`
