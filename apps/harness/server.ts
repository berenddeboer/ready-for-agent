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
} else {
  const { startProductionLifecycle } = await import(
    "./src/server/production-lifecycle.js"
  )
  await startProductionLifecycle()
}
