import { exceedsPromptArgvLimit } from "@ready-for-agent/agent-backend"

const commandPrefix = (command: string): string =>
  command.startsWith("/") ? command : `/${command}`

/**
 * `codex exec` reads the prompt from stdin when the positional prompt is `-`.
 *
 * Codex expands prompt-prefixed Agent Commands (ADR 0041) identically either
 * way, so only size decides: past the argv byte limit argv would fail the spawn
 * with an opaque platform error before Codex starts.
 */
const PROMPT_STDIN_PLACEHOLDER = "-"

/**
 * Compose the prompt body a turn sends, whether on argv or stdin.
 */
export const buildPromptBody = (input: {
  readonly prompt: string
  readonly command?: string
}): string =>
  input.command === undefined
    ? input.prompt
    : `${commandPrefix(input.command)}\n${input.prompt}`.trimEnd()

/** True when the composed prompt body is too large for argv. */
export const shouldUsePromptStdin = (input: {
  readonly prompt: string
  readonly command?: string
}): boolean => exceedsPromptArgvLimit(buildPromptBody(input))

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
 *
 * Past the argv byte limit the positional prompt becomes `-` and the adapter
 * writes the body to the child's stdin instead
 * (see {@link shouldUsePromptStdin}).
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
  const prompt = shouldUsePromptStdin(input)
    ? PROMPT_STDIN_PLACEHOLDER
    : buildPromptBody(input)

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
