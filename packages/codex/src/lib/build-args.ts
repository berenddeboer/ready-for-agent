const commandPrefix = (command: string): string =>
  command.startsWith("/") ? command : `/${command}`

/**
 * Build headless Codex argv for a new or resumed Agent Turn.
 *
 * Every harness launch uses machine-readable JSONL (`--json`), runs
 * unsandboxed (`--sandbox danger-full-access`, ADR 0041), and forces
 * unattended approval (`approval_policy=never`) so operator config cannot
 * hang a turn on mid-tool confirmation. Model and optional reasoning effort
 * are restated on every turn so mid-Session switches work.
 *
 * Resume shape: `codex exec … resume <thread_id> -- <prompt>` with the same
 * exec-level flags so later turns stay unsandboxed, unattended, and JSONL.
 * Prompts are always after `--` so tokens like `resume` are never parsed as
 * subcommands.
 */
export const buildRunArgs = (input: {
  readonly prompt: string
  readonly model: string
  /** Null omits `model_reasoning_effort` so Codex uses the model default. */
  readonly thinkingLevel: string | null
  /** Opaque Codex `thread_id` to resume exactly (not "most recent"). */
  readonly resumeSessionId?: string
  readonly command?: string
}): ReadonlyArray<string> => {
  const prompt =
    input.command === undefined
      ? input.prompt
      : `${commandPrefix(input.command)}\n${input.prompt}`.trimEnd()

  const args: string[] = [
    "exec",
    "--json",
    "--sandbox",
    "danger-full-access",
    "--model",
    input.model,
    // Pin approval independently of sandbox (unlike Grok's combined --yolo).
    // `codex exec` has no `-a`; override via config flag.
    "-c",
    "approval_policy=never",
  ]

  if (input.thinkingLevel !== null) {
    args.push("-c", `model_reasoning_effort=${input.thinkingLevel}`)
  }

  if (input.resumeSessionId !== undefined) {
    args.push("resume", input.resumeSessionId, "--", prompt)
  } else {
    args.push("--", prompt)
  }

  return args
}
