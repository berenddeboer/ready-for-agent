import {
  mcpKeymaxxerLayer,
  sidecarKeymaxxerLayer,
} from "@ready-for-agent/keymaxxer-service"

export const keymaxxerLayerFromEnvironment = (
  environment: Partial<Record<string, string | undefined>> = process.env,
) => {
  const sidecarUrl = environment.KEYMAXXER_SIDECAR_URL?.trim()
  return sidecarUrl === undefined || sidecarUrl === ""
    ? mcpKeymaxxerLayer({ environment })
    : sidecarKeymaxxerLayer(sidecarUrl)
}
