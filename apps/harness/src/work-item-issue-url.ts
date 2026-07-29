export const workItemIssueUrl = (
  forge: string,
  forgeHost: string,
  projectPath: string,
  issueNumber: number,
): string =>
  forge === "gitlab"
    ? `https://${forgeHost}/${projectPath}/-/issues/${issueNumber}`
    : `https://${forgeHost}/${projectPath}/issues/${issueNumber}`
