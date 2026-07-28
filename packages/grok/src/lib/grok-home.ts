import { homedir } from "node:os"
import { join } from "node:path"

export type GrokHomeEnv = Partial<
  Record<"HOME" | "GROK_HOME", string | undefined>
>

export type GrokHomeInput = {
  readonly env?: GrokHomeEnv
  readonly home?: string
  /** Absolute override; when set, env/home are ignored. */
  readonly grokHome?: string
}

const trim = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/**
 * Resolve Grok's on-disk home directory.
 * Honors `GROK_HOME` when set; otherwise `$HOME/.grok` (or `~/.grok`).
 */
export const resolveGrokHome = (input: GrokHomeInput = {}): string => {
  if (input.grokHome !== undefined) {
    const overridden = trim(input.grokHome)
    if (overridden !== undefined) {
      return overridden
    }
  }

  const env = input.env ?? process.env
  const fromEnv = trim(env.GROK_HOME)
  if (fromEnv !== undefined) {
    return fromEnv
  }

  const home = input.home ?? trim(env.HOME) ?? homedir()
  return join(home, ".grok")
}
