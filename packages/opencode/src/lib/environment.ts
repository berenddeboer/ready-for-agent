import { Effect, Schema } from "effect"
import { OpencodeConfigError } from "./errors.js"

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const DEFAULT_MCP_TIMEOUT_MS = 300_000

const isGitHubTokenEnvName = (name: string) =>
  name === "GH_TOKEN" ||
  name === "GITHUB_TOKEN" ||
  name.startsWith("GITHUB_TOKEN_")

const OpencodeConfigObject = Schema.Record(Schema.String, Schema.Unknown)
const OpencodeConfigFromJson = Schema.fromJsonString(OpencodeConfigObject)

export type MakeOpencodeEnvironmentOptions = {
  readonly keymaxxerMcpUrl?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}

export const makeOpencodeEnvironment = Effect.fn("makeOpencodeEnvironment")(
  function* (options: MakeOpencodeEnvironmentOptions) {
    const keymaxxerMcpUrl = options.keymaxxerMcpUrl?.trim()

    const environment =
      options.environment ??
      (yield* Effect.sync(
        () => process.env as Record<string, string | undefined>,
      ))
    const existingConfigContent = environment.OPENCODE_CONFIG_CONTENT
    const config: Record<string, unknown> =
      existingConfigContent === undefined
        ? {}
        : yield* Schema.decodeUnknownEffect(OpencodeConfigFromJson)(
            existingConfigContent,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new OpencodeConfigError({
                  message: "OPENCODE_CONFIG_CONTENT must contain a JSON object",
                  cause,
                }),
            ),
          )
    const mcp = isObject(config.mcp) ? config.mcp : {}
    const { keymaxxer: _keymaxxer, ...mcpWithoutKeymaxxer } = mcp

    const opencodeConfig =
      keymaxxerMcpUrl === undefined || keymaxxerMcpUrl === ""
        ? {
            ...config,
            ...(config.mcp === undefined ? {} : { mcp: mcpWithoutKeymaxxer }),
          }
        : {
            ...config,
            mcp: {
              ...mcp,
              keymaxxer: {
                type: "remote",
                url: keymaxxerMcpUrl,
                enabled: true,
                oauth: false,
                timeout: DEFAULT_MCP_TIMEOUT_MS,
              },
            },
          }

    return {
      ...Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined && !isGitHubTokenEnvName(entry[0]),
        ),
      ),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
    }
  },
)
