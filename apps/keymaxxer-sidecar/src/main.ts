import {
  KeymaxxerError,
  startKeymaxxerFacade,
} from "@ready-for-agent/keymaxxer-service"

export const defaultKeymaxxerSidecarPort = 5032
export const keymaxxerSidecarHost = "127.0.0.1"

export const keymaxxerSidecarPortFromEnvironment = (
  environment: Partial<Record<string, string | undefined>>,
) => {
  const value = environment.KEYMAXXER_SIDECAR_PORT?.trim()
  if (value === undefined || value === "") return defaultKeymaxxerSidecarPort

  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("KEYMAXXER_SIDECAR_PORT must be a valid TCP port")
  }
  return port
}

const start = async () => {
  const port = keymaxxerSidecarPortFromEnvironment(process.env)
  try {
    const facade = await startKeymaxxerFacade({
      host: keymaxxerSidecarHost,
      port,
      environment: process.env,
    })

    const stop = async () => {
      await facade.stop()
      process.exit(0)
    }
    process.once("SIGINT", () => {
      void stop()
    })
    process.once("SIGTERM", () => {
      void stop()
    })
    await new Promise(() => {})
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Keymaxxer Sidecar failed to listen on ${keymaxxerSidecarHost}:${port}. Set KEYMAXXER_SIDECAR_PORT to an unused port.`
    console.error(
      message.startsWith("Keymaxxer Sidecar failed")
        ? message
        : `Keymaxxer Sidecar failed to listen on ${keymaxxerSidecarHost}:${port}. Set KEYMAXXER_SIDECAR_PORT to an unused port.`,
    )
    if (!(error instanceof KeymaxxerError)) {
      // keep stderr single-line for topology test
    }
    process.exitCode = 1
  }
}

if (import.meta.main) {
  void start()
}
