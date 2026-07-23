import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

export type OpencodePathEnv = Partial<
  Record<
    "HOME" | "XDG_DATA_HOME" | "OPENCODE_DB" | "OPENCODE_DISABLE_CHANNEL_DB",
    string | undefined
  >
>

export type OpencodePathInput = {
  readonly env?: OpencodePathEnv
  readonly home?: string
  /**
   * OpenCode release channel baked into the installed binary.
   * Only used by the pure-path fallback when `opencode db path` is unavailable
   * and channel is known; never guessed as `latest` by the production resolver.
   */
  readonly channel?: string
  /** OpenCode binary name/path for `opencode db path`. Defaults to `opencode`. */
  readonly binary?: string
  /** Max wait for `opencode db path` (ms). Defaults to 2000. */
  readonly cliTimeoutMs?: number
}

const DEFAULT_BINARY = "opencode"

const trim = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/**
 * OpenCode user data directory (`Global.Path.data` / `xdg-basedir`).
 * OpenCode uses xdg-basedir on every platform: `$XDG_DATA_HOME/opencode` or
 * `~/.local/share/opencode` — not macOS Application Support / Windows LocalAppData.
 */
export const resolveOpencodeDataDir = (
  input: OpencodePathInput = {},
): string => {
  const env = input.env ?? process.env
  const home = input.home ?? trim(env.HOME) ?? homedir()

  const xdgDataHome = trim(env.XDG_DATA_HOME)
  if (xdgDataHome !== undefined) {
    return join(xdgDataHome, "opencode")
  }

  return join(home, ".local", "share", "opencode")
}

const RELEASE_CHANNELS = new Set(["latest", "beta", "prod"])

const sanitizeChannelFileSegment = (channel: string): string =>
  channel.replace(/[^a-zA-Z0-9._-]/g, "-")

/**
 * Pure path fallback matching OpenCode G4() data-dir / OPENCODE_DB rules when
 * the CLI cannot be invoked. Channel must be supplied for non-release installs;
 * defaults to `latest` → `opencode.db`.
 */
export const resolveOpencodeDbPathFromRules = (
  input: OpencodePathInput = {},
): string => {
  const env = input.env ?? process.env
  const dataDir = resolveOpencodeDataDir(input)
  const openCodeDb = trim(env.OPENCODE_DB)

  if (openCodeDb !== undefined) {
    if (openCodeDb === ":memory:" || isAbsolute(openCodeDb)) {
      return openCodeDb
    }
    return join(dataDir, openCodeDb)
  }

  const channel = trim(input.channel) ?? "latest"
  const disableChannelDb =
    env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    env.OPENCODE_DISABLE_CHANNEL_DB === "true"

  if (RELEASE_CHANNELS.has(channel) || disableChannelDb) {
    return join(dataDir, "opencode.db")
  }

  return join(dataDir, `opencode-${sanitizeChannelFileSegment(channel)}.db`)
}

/** Bound CLI path lookup so a stalled OpenCode binary cannot wedge GraphQL. */
const DEFAULT_CLI_TIMEOUT_MS = 2_000

/**
 * Ask the installed OpenCode binary for its database path (`opencode db path`).
 * Returns null when the binary is missing, exits non-zero, times out, or prints nothing.
 */
export const queryOpencodeDbPathViaCli = (
  binary: string = DEFAULT_BINARY,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = DEFAULT_CLI_TIMEOUT_MS,
): string | null => {
  try {
    const result = Bun.spawnSync({
      cmd: [binary, "db", "path"],
      stdout: "pipe",
      stderr: "ignore",
      env,
      timeout: Math.max(1, Math.trunc(timeoutMs)),
      killSignal: "SIGKILL",
    })
    if (result.exitCode !== 0) {
      return null
    }
    const text = new TextDecoder().decode(result.stdout).trim()
    if (text.length === 0) {
      return null
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim())
    const path = lines.find((line) => line.length > 0)
    return path ?? null
  } catch {
    return null
  }
}

/**
 * Resolve OpenCode SQLite path the same way OpenCode does: prefer
 * `opencode db path` (includes baked-in channel).
 *
 * Pure-path fallback only when unambiguous without guessing channel:
 * - `OPENCODE_DB` is set, or
 * - an explicit `channel` is supplied.
 * Otherwise returns null so callers map to UNAVAILABLE rather than reading
 * a wrong `opencode.db` on non-release installs.
 */
export const resolveOpencodeDbPath = (
  input: OpencodePathInput = {},
): string | null => {
  const binary = trim(input.binary) ?? DEFAULT_BINARY
  const env = input.env ?? process.env
  const cliEnv =
    input.env === undefined
      ? process.env
      : ({ ...process.env, ...input.env } as NodeJS.ProcessEnv)
  const cliTimeoutMs = input.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
  const fromCli = queryOpencodeDbPathViaCli(binary, cliEnv, cliTimeoutMs)
  if (fromCli !== null) {
    return fromCli
  }

  const hasOpenCodeDb = trim(env.OPENCODE_DB) !== undefined
  const hasExplicitChannel = trim(input.channel) !== undefined
  if (!hasOpenCodeDb && !hasExplicitChannel) {
    return null
  }
  return resolveOpencodeDbPathFromRules(input)
}
