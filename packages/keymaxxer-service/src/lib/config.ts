import { Config } from "effect"

export const defaultKeymaxxerSidecarPort = 6057

/**
 * MCP request timeout budget for human-dialog paths (vault unlock, secret-use
 * approval, add-secret). Matches the documented OpenCode/Harness remote MCP
 * timeout (≥ 300s). The MCP SDK default (60s) is too short for those dialogs.
 */
export const KEYMAXXER_HUMAN_DIALOG_TIMEOUT_MS = 300_000

/**
 * Explicit MCP `tools/call` timeout for a Keymaxxer tool.
 * Dialog-capable paths use at least {@link KEYMAXXER_HUMAN_DIALOG_TIMEOUT_MS}.
 * For `keymaxxer_run`, the child command bound (`timeoutMs`) is added so MCP
 * wait time never undercuts the declared execution timeout; the child still
 * enforces `timeoutMs` independently inside Keymaxxer.
 */
export const mcpToolCallTimeoutMs = (
  name: string,
  args: Record<string, unknown> = {},
): number => {
  if (name === "keymaxxer_run") {
    const raw = args.timeoutMs
    const childTimeoutMs =
      typeof raw === "number" && Number.isFinite(raw) && raw > 0
        ? Math.trunc(raw)
        : 0
    return KEYMAXXER_HUMAN_DIALOG_TIMEOUT_MS + childTimeoutMs
  }
  return KEYMAXXER_HUMAN_DIALOG_TIMEOUT_MS
}

const isValidTcpPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65_535

/**
 * Effect Config for KEYMAXXER_SIDECAR_PORT (default 6057).
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
