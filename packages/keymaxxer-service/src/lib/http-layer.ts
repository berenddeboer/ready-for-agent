import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer } from "effect"
import {
  type KeymaxxerToolClient,
  makeKeymaxxerClientService,
} from "./client-service.js"
import { type KeymaxxerError, keymaxxerError } from "./models.js"
import { KeymaxxerService } from "./service.js"

export type SidecarLayerOptions = {
  readonly fetch?: typeof globalThis.fetch
  readonly retryDelayMs?: number
  readonly startupTimeoutMs?: number
  readonly createClient?: () => Promise<KeymaxxerToolClient>
}

export type SidecarMcpClient = KeymaxxerToolClient

export type ParsedSidecarUrl = {
  readonly origin: string
  readonly hostname: string
  readonly port: number
  readonly url: string
}

const parseSidecarUrlSync = (value: string): ParsedSidecarUrl => {
  const url = new URL(value)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === ""
  ) {
    throw new Error(
      "Sidecar URL must be an HTTP IPv4 loopback MCP capability URL",
    )
  }
  const parts = url.pathname.split("/").filter(Boolean)
  if (parts.length !== 2 || parts[1] !== "mcp" || parts[0] === undefined) {
    throw new Error(
      "Sidecar URL must be http://127.0.0.1:<port>/<capability>/mcp",
    )
  }
  return {
    origin: url.origin,
    hostname: url.hostname,
    port: Number(url.port),
    url: url.toString().replace(/\/$/, ""),
  }
}

/** Parse and validate a sidecar capability URL (throws on invalid input). */
export const parseSidecarUrl = (value: string): ParsedSidecarUrl =>
  parseSidecarUrlSync(value)

export const parseSidecarUrlEffect = (
  value: string,
): Effect.Effect<ParsedSidecarUrl, KeymaxxerError> =>
  Effect.try({
    try: () => parseSidecarUrlSync(value),
    catch: () => keymaxxerError("configure", "Invalid Keymaxxer sidecar URL"),
  })

export const sidecarKeymaxxerLayer = (
  value: string,
  options: SidecarLayerOptions = {},
): Layer.Layer<KeymaxxerService, KeymaxxerError> =>
  Layer.effect(
    KeymaxxerService,
    Effect.gen(function* () {
      const parsed = yield* parseSidecarUrlEffect(value)
      const managed = makeKeymaxxerClientService({
        createClient:
          options.createClient ??
          (() => createStreamableHttpClient(parsed.url)),
        failureMessage: () => "Keymaxxer sidecar request failed",
        initialize: waitForTcp(parsed, options),
      })
      return managed.service
    }),
  )

const waitForTcp = (
  parsed: ParsedSidecarUrl,
  options: SidecarLayerOptions,
): Effect.Effect<void, KeymaxxerError> => {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const retryDelayMs = options.retryDelayMs ?? 100
  const startupTimeoutMs = options.startupTimeoutMs ?? 5_000
  const startedAt = Date.now()

  const attempt = (): Effect.Effect<void, KeymaxxerError> =>
    Effect.tryPromise({
      try: async () => {
        const remainingMs = Math.max(
          1,
          startupTimeoutMs - (Date.now() - startedAt),
        )
        // Any HTTP response proves TCP listen; wrong path is intentionally 404.
        await fetchImplementation(`http://${parsed.hostname}:${parsed.port}/`, {
          signal: AbortSignal.timeout(remainingMs),
        })
      },
      catch: () =>
        keymaxxerError("initialize", "Keymaxxer sidecar request failed"),
    }).pipe(
      Effect.catchIf(
        () => true,
        (error): Effect.Effect<void, KeymaxxerError> =>
          Date.now() - startedAt >= startupTimeoutMs
            ? Effect.fail(error)
            : Effect.sleep(`${retryDelayMs} millis`).pipe(
                Effect.flatMap(attempt),
              ),
      ),
      Effect.withSpan("KeymaxxerService.waitForTcp"),
    )

  return attempt()
}

const createStreamableHttpClient = async (
  url: string,
): Promise<KeymaxxerToolClient> => {
  const client = new Client({
    name: "ready-for-agent-harness",
    version: "0.0.0",
  })
  const transport = new StreamableHTTPClientTransport(new URL(url))
  await client.connect(transport)
  return {
    callTool: (input) =>
      client.callTool(input).then((result) => result as never),
    close: () => transport.close(),
  }
}
