const commandPrefix = (command: string): string =>
  command.startsWith("/") ? command : `/${command}`

/**
 * Build headless Grok argv. Every harness launch disables auto-update and runs
 * fully unattended with structured streaming JSON.
 */
export const buildRunArgs = (input: {
  readonly prompt: string
  readonly cwd: string
  readonly model: string
  /** Null omits `--reasoning-effort` so Grok uses the model default. */
  readonly thinkingLevel: string | null
  /** Fresh caller-supplied UUID for a new Session. */
  readonly sessionId?: string
  /** Opaque Session ID to resume exactly (not "most recent"). */
  readonly resumeSessionId?: string
  readonly command?: string
}): ReadonlyArray<string> => {
  const prompt =
    input.command === undefined
      ? input.prompt
      : `${commandPrefix(input.command)}\n${input.prompt}`.trimEnd()

  const args = [
    "--no-auto-update",
    "--output-format",
    "streaming-json",
    "--yolo",
    "--cwd",
    input.cwd,
    "-m",
    input.model,
    "-p",
    prompt,
  ]

  if (input.thinkingLevel !== null) {
    args.push("--reasoning-effort", input.thinkingLevel)
  }

  if (input.resumeSessionId !== undefined) {
    args.push("--resume", input.resumeSessionId)
  } else if (input.sessionId !== undefined) {
    args.push("--session-id", input.sessionId)
  }

  return args
}
