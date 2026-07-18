import {
  isInternalGitHubHelperMode,
  runGitHubHelperProcess,
} from "@ready-for-agent/github-service"
import {
  isInternalKeymaxxerSidecarMode,
  runKeymaxxerSidecarProcess,
} from "@ready-for-agent/keymaxxer-service"

if (isInternalKeymaxxerSidecarMode(process.argv)) {
  await runKeymaxxerSidecarProcess()
} else if (isInternalGitHubHelperMode(process.argv)) {
  runGitHubHelperProcess()
} else {
  const { startProductionLifecycle } = await import(
    "./src/server/production-lifecycle.js"
  )
  await startProductionLifecycle()
}
