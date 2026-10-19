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
   * OpenCode release channel. Used only by session-model path rules, not by
   * Session Telemetry, Agent Turn Tail, or startup-activity detection.
   */
  readonly channel?: string
}

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
 * Path rules for the on-disk session record used by session-model reassertion.
 * Session Telemetry does not call this and does not invoke `opencode db path`.
 * Channel defaults to `latest` → `opencode.db` only for that write path.
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
