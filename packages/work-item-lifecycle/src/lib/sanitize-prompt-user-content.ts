/**
 * Neutralize harness prompt-boundary markers in untrusted text before it is
 * embedded into an Agent Turn prompt.
 *
 * Lifecycle prompts wrap user-controlled or externally observed text in
 * named XML-style sections. If that text itself contains a matching closing
 * tag, it can terminate the section early and inject instructions at the
 * harness level (same class of issue Cloudflare mitigates for MR bodies).
 *
 * Keep this minimal: one tag list, one strip function, one wrap helper —
 * not a general prompt-injection framework.
 */

/**
 * Section tags used when embedding untrusted text into Agent Turn prompts.
 * Opening and closing forms of these names are stripped from content before
 * the real section delimiters are written.
 */
export const PROMPT_BOUNDARY_TAGS = [
  "issue_title",
  "issue_body",
  "issue_comments",
  "publication_title",
  "publication_body",
  "check_name",
  "check_log",
  "diagnostics",
  "command_stderr",
  "failed_reason",
] as const

export type PromptBoundaryTag = (typeof PROMPT_BOUNDARY_TAGS)[number]

// Opening, closing, and self-closing forms (`<tag/>`, `<tag />`, `</tag>`).
const BOUNDARY_TAG_PATTERN = new RegExp(
  `</?(?:${PROMPT_BOUNDARY_TAGS.join("|")})(?:\\s[^>]*)?/?>`,
  "gi",
)

/**
 * Strip harness prompt-boundary tags from untrusted text.
 * Normal prose, Markdown, and code without those exact tags pass through
 * unchanged.
 */
export const sanitizePromptUserContent = (text: string): string =>
  text.replace(BOUNDARY_TAG_PATTERN, "")

/**
 * Sanitize untrusted text and wrap it in a named prompt section so the
 * model can see clear start/end boundaries that content cannot forge.
 * Multi-line content is kept as-is between the tags; no extra blank lines
 * are inserted.
 */
export const promptUserContentSection = (
  tag: PromptBoundaryTag,
  text: string,
): string => {
  const safe = sanitizePromptUserContent(text)
  return `<${tag}>${safe}</${tag}>`
}
