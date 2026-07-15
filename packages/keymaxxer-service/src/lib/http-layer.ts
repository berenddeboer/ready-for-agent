import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer } from "effect"
import {
  KeymaxxerError,
  validateRunInput,
  validateSecretName,
} from "./models.js"
import { KeymaxxerService, type KeymaxxerServiceShape } from "./service.js"

export type SidecarLayerOptions = {
  readonly fetch?: typeof globalThis.fetch
  readonly retryDelayMs?: number
  readonly startupTimeoutMs?: number
  readonly createClient?: () => Promise<SidecarMcpClient>
}

export type SidecarMcpClient = {
  readonly callTool: (input: {
    readonly name: string
    readonly arguments: Record<string, unknown>
  }) => Promise<{
    content?: unknown
    isError?: boolean
    structuredContent?: unknown
  }>
  readonly close: () => Promise<void>
}

export type ParsedSidecarUrl = {
  readonly origin: string
  readonly hostname: string
  readonly port: number
  readonly url: string
}

export const parseSidecarUrl = (value: string): ParsedSidecarUrl => {
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

export const sidecarKeymaxxerLayer = (
  value: string,
  options: SidecarLayerOptions = {},
): Layer.Layer<KeymaxxerService, KeymaxxerError> =>
  Layer.effect(
    KeymaxxerService,
    Effect.try({
      try: () => makeSidecarService(parseSidecarUrl(value), options),
      catch: () => safeError("configure", "Invalid Keymaxxer sidecar URL"),
    }),
  )

const makeSidecarService = (
  parsed: ParsedSidecarUrl,
  options: SidecarLayerOptions,
): KeymaxxerServiceShape => {
  const retryDelayMs = options.retryDelayMs ?? 100
  const startupTimeoutMs = options.startupTimeoutMs ?? 5_000
  let clientPromise: Promise<SidecarMcpClient> | null = null
  let secretsPromise: Promise<readonly SecretMetadata[]> | null = null

  const getClient = () => {
    clientPromise ??= (
      options.createClient ?? (() => createStreamableHttpClient(parsed.url))
    )()
    return clientPromise
  }

  const callTool = async (
    operation: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    try {
      const result = await (await getClient()).callTool({
        name,
        arguments: args,
      })
      return {
        isError: result.isError === true,
        structuredContent: result.structuredContent,
        text: toolResultText(result),
      }
    } catch {
      const failed = clientPromise
      clientPromise = null
      secretsPromise = null
      await failed?.then((client) => client.close()).catch(() => undefined)
      throw safeError(operation, "Keymaxxer sidecar request failed")
    }
  }

  const listSecrets = async (refresh = false) => {
    if (!refresh && secretsPromise !== null) return secretsPromise
    secretsPromise = callTool("listSecrets", "keymaxxer_list", {}).then(
      (result) => {
        if (result.isError)
          throw safeError("listSecrets", "Keymaxxer list failed")
        return parseSecrets(result.text)
      },
    )
    secretsPromise.catch(() => {
      secretsPromise = null
    })
    return secretsPromise
  }

  const findSecretNames = async (
    inputs: readonly { readonly provider: string; readonly account: string }[],
  ) => {
    const secrets = await listSecrets(true)
    return inputs.map((input) => {
      const matches = secrets.filter(
        (secret) =>
          secret.provider?.toLowerCase() === input.provider.toLowerCase() &&
          secret.account?.toLowerCase() === input.account.toLowerCase(),
      )
      if (matches.length > 1) {
        throw safeError(
          "findSecrets",
          "Multiple Keymaxxer secrets match provider and account",
        )
      }
      return matches[0]?.name ?? null
    })
  }

  const waitForTcp = (): Effect.Effect<void, KeymaxxerError> => {
    const fetchImplementation = options.fetch ?? globalThis.fetch
    const startedAt = Date.now()
    const attempt = (): Effect.Effect<void, KeymaxxerError> =>
      Effect.tryPromise({
        try: async () => {
          const remainingMs = Math.max(
            1,
            startupTimeoutMs - (Date.now() - startedAt),
          )
          // Any HTTP response proves TCP listen; wrong path is intentionally 404.
          await fetchImplementation(
            `http://${parsed.hostname}:${parsed.port}/`,
            {
              signal: AbortSignal.timeout(remainingMs),
            },
          )
        },
        catch: () =>
          safeError("initialize", "Keymaxxer sidecar request failed"),
      }).pipe(
        Effect.catchIf(
          () => true,
          (error) =>
            Date.now() - startedAt >= startupTimeoutMs
              ? Effect.fail(error)
              : Effect.sleep(`${retryDelayMs} millis`).pipe(
                  Effect.flatMap(attempt),
                ),
        ),
      )
    return attempt()
  }

  return {
    initialize: waitForTcp(),
    hasSecret: (name) =>
      validateSecretName(name)
        ? Effect.tryPromise({
            try: async () => {
              const hasName = (secrets: readonly SecretMetadata[]) =>
                secrets.some((secret) => secret.name === name)
              return (
                hasName(await listSecrets()) || hasName(await listSecrets(true))
              )
            },
            catch: () => safeError("hasSecret", "Keymaxxer list failed"),
          })
        : Effect.fail(safeError("hasSecret", "Invalid secret name")),
    findSecret: (input) =>
      Effect.tryPromise({
        try: () => findSecretNames([input]).then(([found]) => found ?? null),
        catch: (error) =>
          error instanceof KeymaxxerError
            ? error
            : safeError("findSecret", "Keymaxxer list failed"),
      }),
    findSecrets: (inputs) =>
      Effect.tryPromise({
        try: () => findSecretNames(inputs),
        catch: (error) =>
          error instanceof KeymaxxerError
            ? error
            : safeError("findSecrets", "Keymaxxer list failed"),
      }),
    addSecret: (input) =>
      validateSecretName(input.name)
        ? Effect.tryPromise({
            try: async () => {
              const result = await callTool("addSecret", "keymaxxer_add", input)
              if (result.text.toLowerCase().includes("cancelled")) return false
              if (result.isError) {
                throw safeError("addSecret", "Keymaxxer add failed")
              }
              await listSecrets(true)
              return true
            },
            catch: () => safeError("addSecret", "Keymaxxer add failed"),
          })
        : Effect.fail(safeError("addSecret", "Invalid secret name")),
    removeSecret: (name) =>
      validateSecretName(name)
        ? Effect.tryPromise({
            try: async () => {
              const result = await callTool("removeSecret", "keymaxxer_rm", {
                name,
              })
              if (result.isError) {
                throw safeError("removeSecret", "Keymaxxer remove failed")
              }
              await listSecrets(true)
              return result.text.toLowerCase().includes("removed")
            },
            catch: () => safeError("removeSecret", "Keymaxxer remove failed"),
          })
        : Effect.fail(safeError("removeSecret", "Invalid secret name")),
    runWithSecrets: (input) =>
      validateRunInput(input)
        ? Effect.tryPromise({
            try: async () => {
              const result = await callTool(
                "runWithSecrets",
                "keymaxxer_run",
                input,
              )
              const parsedResult =
                parseStructuredRunResult(result.structuredContent) ??
                parseRunResult(result.text)
              if (parsedResult === null) {
                throw safeError(
                  "runWithSecrets",
                  "Keymaxxer returned an invalid command result",
                )
              }
              return parsedResult
            },
            catch: () =>
              safeError("runWithSecrets", "Keymaxxer command failed"),
          })
        : Effect.fail(safeError("runWithSecrets", "Invalid command input")),
  }
}

const createStreamableHttpClient = async (
  url: string,
): Promise<SidecarMcpClient> => {
  const client = new Client({
    name: "ready-for-agent-harness",
    version: "0.0.0",
  })
  const transport = new StreamableHTTPClientTransport(new URL(url))
  await client.connect(transport)
  return {
    callTool: (input) =>
      client.callTool(input).then(
        (result) =>
          result as {
            content?: unknown
            isError?: boolean
            structuredContent?: unknown
          },
      ),
    close: () => transport.close(),
  }
}

type SecretMetadata = {
  readonly name: string
  readonly provider: string | null
  readonly account: string | null
}

const toolResultText = (result: { readonly content?: unknown }) =>
  Array.isArray(result.content)
    ? result.content
        .map((item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string"
            ? item.text
            : "",
        )
        .join("\n")
    : ""

const parseSecrets = (text: string): readonly SecretMetadata[] => {
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) throw new Error("Invalid secret list")

  return parsed.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("name" in item) ||
      typeof item.name !== "string"
    ) {
      throw new Error("Invalid secret list")
    }
    const provider = "provider" in item ? item.provider : null
    const account = "account" in item ? item.account : null
    if (
      (provider !== null && typeof provider !== "string") ||
      (account !== null && typeof account !== "string")
    ) {
      throw new Error("Invalid secret list")
    }
    return { name: item.name, provider, account }
  })
}

const parseRunResult = (text: string) => {
  const exitCode = text.match(/^exit_code: (-?\d+)$/m)
  const stdoutMarker = "--- stdout ---\n"
  const stderrMarker = "\n--- stderr ---\n"
  const stdoutStart = text.indexOf(stdoutMarker)
  const stderrStart = text.indexOf(
    stderrMarker,
    stdoutStart + stdoutMarker.length,
  )
  const repeatedMarker = text.indexOf(stderrMarker, stderrStart + 1)
  if (!exitCode || stdoutStart < 0 || stderrStart < stdoutStart) return null
  if (repeatedMarker >= 0) return null

  return {
    exitCode: Number.parseInt(exitCode[1] ?? "", 10),
    stdout: text.slice(stdoutStart + stdoutMarker.length, stderrStart),
    stderr: text.slice(stderrStart + stderrMarker.length),
  }
}

const parseStructuredRunResult = (value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("exitCode" in value) ||
    typeof value.exitCode !== "number" ||
    !("stdout" in value) ||
    typeof value.stdout !== "string" ||
    !("stderr" in value) ||
    typeof value.stderr !== "string"
  ) {
    return null
  }

  return {
    exitCode: value.exitCode,
    stdout: value.stdout,
    stderr: value.stderr,
  }
}

const safeError = (operation: string, message: string) =>
  new KeymaxxerError({ operation, message })
