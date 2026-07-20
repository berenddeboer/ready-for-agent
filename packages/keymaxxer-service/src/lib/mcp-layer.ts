import { accessSync, constants, existsSync } from "node:fs"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Config, Effect, Layer } from "effect"
import {
  type KeymaxxerToolClient,
  makeKeymaxxerClientService,
} from "./client-service.js"
import { KeymaxxerService } from "./service.js"

export type { KeymaxxerToolClient, ToolResult } from "./client-service.js"

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
      Effect.sync(() =>
        makeKeymaxxerClientService({
          createClient:
            options.createClient ?? (() => createToolClient(options)),
          failureMessage: () => "Keymaxxer operation failed",
        }),
      ),
      (managed) => managed.close,
    ).pipe(Effect.map((managed) => managed.service)),
  )

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
      client.callTool(input).then((result) => result as never),
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

const sourceEntrypointPattern = /\.(m?[jt]sx?|cjs|mts|cts)$/i

/** True when ENTRYPOINT should be exec'd directly (not via Bun as source). */
export const isExecutableKeymaxxerEntrypoint = (
  path: string,
  access: (path: string, mode: number) => void = accessSync,
): boolean => {
  if (sourceEntrypointPattern.test(path)) return false
  try {
    access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Effect Config for KEYMAXXER_ENTRYPOINT (optional). */
export const KeymaxxerEntrypointConfig = Config.string(
  "KEYMAXXER_ENTRYPOINT",
).pipe(Config.option)

export const keymaxxerMcpCommand = (
  environment: Partial<Record<string, string | undefined>> = process.env,
  pathExists: (path: string) => boolean = existsSync,
  isExecutable: (path: string) => boolean = isExecutableKeymaxxerEntrypoint,
) => {
  const entrypoint = environment.KEYMAXXER_ENTRYPOINT?.trim()

  if (entrypoint && pathExists(entrypoint)) {
    if (isExecutable(entrypoint)) {
      return { command: entrypoint, args: ["serve"] }
    }
    return { command: "bun", args: [entrypoint, "serve"] }
  }

  return { command: "keymaxxer", args: ["serve"] }
}

export const isKeymaxxerAvailable = (
  environment: Partial<Record<string, string | undefined>> = process.env,
  pathExists: (path: string) => boolean = existsSync,
  commandExists: (command: string) => boolean = (command) =>
    Bun.which(command) !== null,
  isExecutable: (path: string) => boolean = isExecutableKeymaxxerEntrypoint,
) => {
  const entrypoint = environment.KEYMAXXER_ENTRYPOINT?.trim()
  if (entrypoint && pathExists(entrypoint)) return true
  const command = keymaxxerMcpCommand(environment, pathExists, isExecutable)
  return commandExists(command.command)
}
