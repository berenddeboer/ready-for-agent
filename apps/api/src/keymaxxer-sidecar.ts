import { Effect } from "effect"
import {
  KeymaxxerError,
  KeymaxxerService,
  createKeymaxxerSidecarFetch,
  mcpKeymaxxerLayer,
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

const program = Effect.scoped(
  Effect.gen(function* () {
    const keymaxxer = yield* KeymaxxerService
    const port = keymaxxerSidecarPortFromEnvironment(process.env)
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            fetch: createKeymaxxerSidecarFetch(keymaxxer),
            hostname: keymaxxerSidecarHost,
            port,
          }),
        catch: () =>
          new KeymaxxerError({
            operation: "sidecar",
            message: `Keymaxxer Sidecar failed to listen on ${keymaxxerSidecarHost}:${port}. Set KEYMAXXER_SIDECAR_PORT to an unused port.`,
          }),
      }),
      (runningServer) => Effect.promise(() => runningServer.stop(true)),
    )

    yield* Effect.log(
      `Keymaxxer Sidecar listening on http://${server.hostname}:${server.port}`,
    )
    return yield* Effect.never
  }).pipe(Effect.provide(mcpKeymaxxerLayer())),
)

if (import.meta.main) {
  const abortController = new AbortController()
  process.once("SIGINT", () => abortController.abort())
  process.once("SIGTERM", () => abortController.abort())

  Effect.runPromise(program, { signal: abortController.signal }).catch(() => {
    if (!abortController.signal.aborted) {
      console.error("Keymaxxer Sidecar startup failed")
      process.exitCode = 1
    }
  })
}
