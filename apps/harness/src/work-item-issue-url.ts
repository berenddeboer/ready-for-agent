import { splitAzureDevOpsProjectPath } from "@ready-for-agent/azure-devops-service/types"

export const workItemIssueUrl = (
  forge: string,
  forgeHost: string,
  projectPath: string,
  issueNumber: number,
): string | null => {
  switch (forge) {
    case "azure-devops": {
      const identity = splitAzureDevOpsProjectPath(projectPath)
      if (identity === null) return null
      return `https://${forgeHost}/${encodeURIComponent(identity.organization)}/${encodeURIComponent(identity.project)}/_workitems/edit/${issueNumber}`
    }
    case "gitlab":
      return `https://${forgeHost}/${projectPath}/-/issues/${issueNumber}`
    case "github":
      return `https://${forgeHost}/${projectPath}/issues/${issueNumber}`
    default:
      return null
  }
}
