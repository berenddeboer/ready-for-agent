const commandPrefix = (command: string): string =>
  command.startsWith("/") ? command : `/${command}`

/**
 * Build headless Claude Code argv for a new or resumed Agent Turn.
 *
 * Every harness launch uses print mode (`-p`), machine-readable
 * `--output-format stream-json` with `--verbose` (required for terminal
 * `result` events), and unattended `--dangerously-skip-permissions`. Model and
 * optional effort are restated on every turn so mid-Session switches work.
 *
 * Session identity is always an exact UUID: `--session-id` on start and
 * `--resume` on continue. Directory-scoped `--continue` and resume-forking
 * `--fork-session` are never used (ADR 0047). `--bare` is never used so
 * CLAUDE.md discovery and ambient OAuth work.
 */
export const buildRunArgs = (input: {
  readonly prompt: string
  readonly model: string
  /** Null omits `--effort` so Claude uses the model default. */
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

  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    // Terminal `result` events require verbose with stream-json.
    "--verbose",
    "--dangerously-skip-permissions",
    "--model",
    input.model,
  ]

  if (input.thinkingLevel !== null) {
    args.push("--effort", input.thinkingLevel)
  }

  if (input.resumeSessionId !== undefined) {
    args.push("--resume", input.resumeSessionId)
  } else if (input.sessionId !== undefined) {
    args.push("--session-id", input.sessionId)
  }

  // Isolate the prompt after `--` so bodies that start with `-`/`--` are not
  // consumed as CLI flags (Claude Code accepts this end-of-options form).
  args.push("--", prompt)

  return args
}
