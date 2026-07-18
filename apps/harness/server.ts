import {
  isInternalKeymaxxerSidecarMode,
  runKeymaxxerSidecarProcess,
} from "@ready-for-agent/keymaxxer-service"

if (isInternalKeymaxxerSidecarMode(process.argv)) {
  await runKeymaxxerSidecarProcess()
} else {
  const { startProductionLifecycle } = await import(
    "./src/server/production-lifecycle.js"
  )
  await startProductionLifecycle()
}
