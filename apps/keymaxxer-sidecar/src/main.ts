import {
  defaultKeymaxxerSidecarPort,
  keymaxxerSidecarHost,
  keymaxxerSidecarPortFromEnvironment,
  runKeymaxxerSidecarProcess,
} from "@ready-for-agent/keymaxxer-service"

export {
  defaultKeymaxxerSidecarPort,
  keymaxxerSidecarHost,
  keymaxxerSidecarPortFromEnvironment,
}

if (import.meta.main) {
  void runKeymaxxerSidecarProcess()
}
