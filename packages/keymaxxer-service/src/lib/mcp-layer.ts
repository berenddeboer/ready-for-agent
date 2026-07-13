import { existsSync } from "node:fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Effect, Layer } from "effect"
import {
  KeymaxxerError,
  validateRunInput,
  validateSecretName,
} from "./models.js"
import { KeymaxxerService, type KeymaxxerServiceShape } from "./service.js"

type ToolResult = {
  readonly content?: unknown
  readonly isError?: boolean
  readonly structuredContent?: unknown
}

export interface KeymaxxerToolClient {
  readonly callTool: (input: {
    readonly arguments: Record<string, unknown>
    readonly name: string
  }) => Promise<ToolResult>
  readonly close: () => Promise<void>
}

export type McpLayerOptions = {
  readonly createClient?: () => Promise<KeymaxxerToolClient>
  readonly environment?: Partial<Record<string, string | undefined>>
}

export const mcpKeymaxxerLayer = (
  options: McpLayerOptions = {},
): Layer.Layer<KeymaxxerService> =>
  Layer.effect(
    KeymaxxerService,
    Effect.acquireRelease(
      Effect.sync(() => makeMcpService(options)),
      (managed) => Effect.promise(managed.close),
    ).pipe(Effect.map((managed) => managed.service)),
  )

const makeMcpService = (options: McpLayerOptions) => {
  let clientPromise: Promise<KeymaxxerToolClient> | null = null
  let secretNamesPromise: Promise<Set<string>> | null = null

  const getClient = () => {
    clientPromise ??= (
      options.createClient ?? (() => createToolClient(options))
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
        arguments: args,
        name,
      })
      return {
        isError: result.isError === true,
        structuredContent: result.structuredContent,
        text: toolResultText(result),
      }
    } catch {
      const failedClient = clientPromise
      clientPromise = null
      secretNamesPromise = null
      await failedClient
        ?.then((client) => client.close())
        .catch(() => undefined)
      throw safeError(operation, "Keymaxxer operation failed")
    }
  }

  const listSecretNames = async (refresh = false) => {
    if (!refresh && secretNamesPromise !== null) return secretNamesPromise

    secretNamesPromise = callTool("hasSecret", "keymaxxer_list", {}).then(
      (result) => {
        if (result.isError)
          throw safeError("hasSecret", "Keymaxxer list failed")
        return parseSecretNames(result.text)
      },
    )
    secretNamesPromise.catch(() => {
      secretNamesPromise = null
    })
    return secretNamesPromise
  }

  const service: KeymaxxerServiceShape = {
    initialize: Effect.tryPromise({
      try: () => listSecretNames().then(() => undefined),
      catch: () => safeError("initialize", "Keymaxxer initialization failed"),
    }),
    hasSecret: (name) =>
      validateSecretName(name)
        ? Effect.tryPromise({
            try: async () => {
              const names = await listSecretNames()
              return names.has(name) || (await listSecretNames(true)).has(name)
            },
            catch: () => safeError("hasSecret", "Keymaxxer list failed"),
          })
        : Effect.fail(safeError("hasSecret", "Invalid secret name")),
    addSecret: (input) =>
      validateSecretName(input.name)
        ? Effect.tryPromise({
            try: async () => {
              const result = await callTool("addSecret", "keymaxxer_add", input)
              if (result.text.toLowerCase().includes("cancelled")) return false
              if (result.isError) {
                throw safeError("addSecret", "Keymaxxer add failed")
              }
              ;(await listSecretNames()).add(input.name)
              return true
            },
            catch: () => safeError("addSecret", "Keymaxxer add failed"),
          })
        : Effect.fail(safeError("addSecret", "Invalid secret name")),
    runWithSecrets: (input) =>
      validateRunInput(input)
        ? Effect.tryPromise({
            try: async () => {
              const result = await callTool(
                "runWithSecrets",
                "keymaxxer_run",
                input,
              )
              const parsed =
                parseStructuredRunResult(result.structuredContent) ??
                parseRunResult(result.text)
              if (parsed === null) {
                throw safeError(
                  "runWithSecrets",
                  "Keymaxxer returned an invalid command result",
                )
              }
              return parsed
            },
            catch: () =>
              safeError("runWithSecrets", "Keymaxxer command failed"),
          })
        : Effect.fail(safeError("runWithSecrets", "Invalid command input")),
  }

  return {
    service,
    close: async () => {
      const current = clientPromise
      clientPromise = null
      secretNamesPromise = null
      await current?.then((client) => client.close()).catch(() => undefined)
    },
  }
}

const createToolClient = async (
  options: McpLayerOptions,
): Promise<KeymaxxerToolClient> => {
  const environment = options.environment ?? process.env
  const launch = keymaxxerMcpCommand(environment)
  const client = new Client({ name: "ready-for-agent", version: "0.0.0" })
  const transport = new StdioClientTransport({
    args: launch.args,
    command: launch.command,
    env: keymaxxerEnvironment(environment),
    stderr: "pipe",
  })
  await client.connect(transport)

  return {
    callTool: (input) =>
      client.callTool(input).then((result) => result as unknown as ToolResult),
    close: () => transport.close(),
  }
}

export const keymaxxerEnvironment = (
  environment: Partial<Record<string, string | undefined>>,
) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined &&
        name !== "GITHUB_TOKEN" &&
        !name.startsWith("GITHUB_TOKEN_"),
    ),
  ) as Record<string, string>

export const keymaxxerMcpCommand = (
  environment: Partial<Record<string, string | undefined>> = process.env,
) => {
  const entrypoint =
    environment.KEYMAXXER_ENTRYPOINT ??
    "/home/berend/src/contrib/keymaxxer/packages/cli/src/index.ts"

  return existsSync(entrypoint)
    ? { command: "bun", args: [entrypoint, "serve"] }
    : { command: "keymaxxer", args: ["serve"] }
}

const toolResultText = (result: ToolResult) =>
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

const parseSecretNames = (text: string) => {
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) throw new Error("Invalid secret list")

  const names = new Set<string>()
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      "name" in item &&
      typeof item.name === "string"
    ) {
      names.add(item.name)
    }
  }
  return names
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
