import {
  isInternalAzureDevOpsHelperMode,
  runAzureDevOpsHelperProcess,
} from "@ready-for-agent/azure-devops-service"
import {
  isInternalGitHubHelperMode,
  runGitHubHelperProcess,
} from "@ready-for-agent/github-service"
import {
  isInternalGitLabHelperMode,
  runGitLabHelperProcess,
} from "@ready-for-agent/gitlab-service"
import {
  isInternalKeymaxxerSidecarMode,
  runKeymaxxerSidecarProcess,
} from "@ready-for-agent/keymaxxer-service"

if (isInternalKeymaxxerSidecarMode(process.argv)) {
  await runKeymaxxerSidecarProcess()
} else if (isInternalGitHubHelperMode(process.argv)) {
  runGitHubHelperProcess()
} else if (isInternalGitLabHelperMode(process.argv)) {
  runGitLabHelperProcess()
} else if (isInternalAzureDevOpsHelperMode(process.argv)) {
  runAzureDevOpsHelperProcess()
} else {
  const { startProductionLifecycle } = await import(
    "./src/server/production-lifecycle.js"
  )
  await startProductionLifecycle()
}
