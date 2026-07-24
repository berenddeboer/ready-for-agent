const commandName = (command: string): string =>
  command.startsWith("/") ? command.slice(1) : command

const messageTokens = (prompt: string): ReadonlyArray<string> =>
  prompt
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)

export const shouldUsePromptStdin = (prompt: string): boolean =>
  /\r|\n/.test(prompt)

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
    const tokens = messageTokens(input.prompt)
    if (tokens.length > 0) {
      args.push("--", ...tokens)
    }
    return args
  }

  if (!shouldUsePromptStdin(input.prompt)) {
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
