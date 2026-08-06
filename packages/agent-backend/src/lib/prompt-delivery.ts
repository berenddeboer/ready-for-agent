/**
 * Byte ceiling for an Agent Turn prompt carried in CLI argv.
 *
 * Linux bounds a spawn's argv+env by `ARG_MAX` and caps any single argument at
 * `MAX_ARG_STRLEN` (128 KiB), so a large prompt on argv fails the spawn with an
 * opaque platform error rather than an Agent Backend error. 64 KiB stays well
 * under both bounds while leaving ordinary lifecycle prompts on argv.
 */
export const PROMPT_ARGV_BYTE_LIMIT = 64 * 1024

/**
 * True when a prompt is too large to hand to a CLI through argv and must be
 * delivered out of band (stdin, or a prompt file for CLIs that ignore stdin).
 */
export const exceedsPromptArgvLimit = (prompt: string): boolean =>
  Buffer.byteLength(prompt, "utf8") > PROMPT_ARGV_BYTE_LIMIT
