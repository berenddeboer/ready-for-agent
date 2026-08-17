import { exceedsPromptArgvLimit } from "@ready-for-agent/agent-backend"

const commandPrefix = (command: string): string =>
  command.startsWith("/") ? command : `/${command}`

/**
 * Compose the prompt body a turn sends, whether on argv or in a prompt file.
 *
 * Agent Commands are prompt-prefixed; Grok expands `/name` identically from
 * `-p` and from `--prompt-file`.
 */
export const buildPromptBody = (input: {
  readonly prompt: string
  readonly command?: string
}): string =>
  input.command === undefined
    ? input.prompt
    : `${commandPrefix(input.command)}\n${input.prompt}`.trimEnd()

/**
 * True when the composed prompt body is too large to hand to `-p` on argv.
 *
 * Unlike the other CLI backends, headless Grok does not read piped stdin into
 * the prompt, so the out-of-band route is `--prompt-file <PATH>`; the adapter
 * writes the body to a scoped temp file for the life of the turn.
 */
export const shouldUsePromptFile = (input: {
  readonly prompt: string
  readonly command?: string
}): boolean => exceedsPromptArgvLimit(buildPromptBody(input))

/**
 * Build headless Grok argv. Every harness launch disables auto-update and runs
 * fully unattended with structured streaming JSON.
 *
 * The prompt body rides on `-p` unless {@link shouldUsePromptFile} says it is
 * too large for argv, in which case the caller supplies `promptFile` and argv
 * carries `--prompt-file <PATH>` instead. On argv a large body would fail the
 * spawn with an opaque platform error rather than an Agent Backend error.
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
  /** Path holding the prompt body when it is too large for argv. */
  readonly promptFile?: string
}): ReadonlyArray<string> => {
  const args = [
    "--no-auto-update",
    "--output-format",
    "streaming-json",
    "--yolo",
    "--cwd",
    input.cwd,
    "-m",
    input.model,
    ...(input.promptFile !== undefined
      ? ["--prompt-file", input.promptFile]
      : ["-p", buildPromptBody(input)]),
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

export const buildAcpContinueArgs = (input: {
  readonly model: string
  readonly thinkingLevel: string | null
}): ReadonlyArray<string> => [
  "--no-auto-update",
  "agent",
  "--no-leader",
  "--always-approve",
  "-m",
  input.model,
  ...(input.thinkingLevel !== null
    ? ["--reasoning-effort", input.thinkingLevel]
    : []),
  "stdio",
]
