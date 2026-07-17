const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const DEFAULT_MCP_TIMEOUT_MS = 300_000

const isGitHubTokenEnvName = (name: string) =>
  name === "GH_TOKEN" ||
  name === "GITHUB_TOKEN" ||
  name.startsWith("GITHUB_TOKEN_")

export type MakeOpencodeEnvironmentOptions = {
  readonly keymaxxerMcpUrl?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}

export const makeOpencodeEnvironment = (
  options: MakeOpencodeEnvironmentOptions,
): Record<string, string> => {
  const keymaxxerMcpUrl = options.keymaxxerMcpUrl?.trim()

  const environment = options.environment ?? process.env
  const existingConfigContent = environment.OPENCODE_CONFIG_CONTENT
  const config: Record<string, unknown> =
    existingConfigContent === undefined
      ? {}
      : (() => {
          const parsed: unknown = JSON.parse(existingConfigContent)
          if (!isObject(parsed)) {
            throw new TypeError(
              "OPENCODE_CONFIG_CONTENT must contain a JSON object",
            )
          }
          return parsed
        })()
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
}
