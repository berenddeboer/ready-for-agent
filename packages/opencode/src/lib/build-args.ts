import { exceedsPromptArgvLimit } from "@ready-for-agent/agent-backend"

const commandName = (command: string): string =>
  command.startsWith("/") ? command.slice(1) : command

const messageTokens = (prompt: string): ReadonlyArray<string> =>
  prompt
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)

/**
 * Prompts go through stdin when argv cannot carry them faithfully or safely.
 *
 * Non-command prompts lose their structure once tokenized, so any newline sends
 * them to stdin. Either shape goes to stdin past the argv byte limit: a
 * single-line pasted stack trace or inlined diff would otherwise fail the spawn
 * with an opaque platform error instead of an Agent Backend error. Command
 * prompts below the limit stay tokenized after `--` so `$ARGUMENTS` keeps its
 * established argv shape.
 */
export const shouldUsePromptStdin = (input: {
  readonly prompt: string
  readonly command?: string
}): boolean =>
  exceedsPromptArgvLimit(input.prompt) ||
  (input.command === undefined && /\r|\n/.test(input.prompt))

export const buildRunArgs = (input: {
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  /** Null omits `--variant` so OpenCode uses the model default. */
  readonly thinkingLevel: string | null
  readonly sessionId?: string
  readonly command?: string
}): ReadonlyArray<string> => {
  const args = [
    "run",
    "--auto",
    "--format",
    "json",
    "--dir",
    input.cwd,
    "-m",
    input.model,
  ]

  if (input.thinkingLevel !== null) {
    args.push("--variant", input.thinkingLevel)
  }

  if (input.sessionId !== undefined) {
    args.push("--session", input.sessionId)
  }

  if (input.command !== undefined) {
    args.push("--command", commandName(input.command))
  }

  if (!shouldUsePromptStdin(input)) {
    const tokens = messageTokens(input.prompt)
    if (tokens.length > 0) {
      args.push("--", ...tokens)
    }
  }
  return args
}

export const joinOpenCodeMessageArgs = (
  messageArgs: ReadonlyArray<string>,
): string =>
  messageArgs
    .map((token) =>
      token.includes(" ") ? `"${token.replace(/"/g, '\\"')}"` : token,
    )
    .join(" ")
