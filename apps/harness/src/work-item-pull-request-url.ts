import {
  azureDevOpsRepositoryName,
  splitAzureDevOpsProjectPath,
} from "@ready-for-agent/azure-devops-service/types"

export const workItemPullRequestUrl = (
  forge: string,
  forgeHost: string,
  projectPath: string,
  pullRequestNumber: number | null,
): string | null => {
  if (pullRequestNumber === null) return null
  switch (forge) {
    case "azure-devops": {
      const identity = splitAzureDevOpsProjectPath(projectPath)
      if (identity === null) return null
      const repositoryName = azureDevOpsRepositoryName(identity)
      return `https://${forgeHost}/${encodeURIComponent(identity.organization)}/${encodeURIComponent(identity.project)}/_git/${encodeURIComponent(repositoryName)}/pullrequest/${pullRequestNumber}`
    }
    case "gitlab":
      return `https://${forgeHost}/${projectPath}/-/merge_requests/${pullRequestNumber}`
    case "github":
      return `https://${forgeHost}/${projectPath}/pull/${pullRequestNumber}`
    default:
      return null
  }
}
