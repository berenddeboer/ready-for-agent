import { Config } from "effect"

export const defaultKeymaxxerSidecarPort = 5032

const isValidTcpPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65_535

/**
 * Effect Config for KEYMAXXER_SIDECAR_PORT (default 5032).
 * Process entrypoints may still read env synchronously via
 * `keymaxxerSidecarPortFromEnvironment`.
 */
export const KeymaxxerSidecarPortConfig = Config.int(
  "KEYMAXXER_SIDECAR_PORT",
).pipe(
  Config.orElse(() => Config.succeed(defaultKeymaxxerSidecarPort)),
  Config.map((port) => {
    if (!isValidTcpPort(port)) {
      throw new Error(
        `KEYMAXXER_SIDECAR_PORT must be a valid TCP port (got ${port})`,
      )
    }
    return port
  }),
)
