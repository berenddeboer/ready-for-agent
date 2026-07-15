const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const makeOpencodeEnvironment = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
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
  const keymaxxer = isObject(mcp.keymaxxer) ? mcp.keymaxxer : {}

  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      mcp: {
        ...mcp,
        keymaxxer: { ...keymaxxer, enabled: false },
      },
    }),
  } as const
}
