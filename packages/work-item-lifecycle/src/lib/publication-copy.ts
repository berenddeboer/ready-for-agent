/**
 * Shared Commit and Create PR publication copy: parse, normalize, and bound
 * agent-authored title/body used identically for git commit and draft PR.
 */

import { promptUserContentSection } from "./sanitize-prompt-user-content.js"

/** GitHub pull request title limit. */
export const PUBLICATION_TITLE_MAX_LENGTH = 256

/**
 * Keep bodies well under GitHub's 65536-character PR body limit while still
 * allowing useful reviewer prose.
 */
export const PUBLICATION_BODY_MAX_LENGTH = 32_000

export type PublicationCopy = {
  readonly title: string
  readonly body: string
}

const RESULT_LINE =
  /^READY_FOR_AGENT_RESULT:\s*PUBLICATION_COPY(?:\s+(\{[\s\S]*\}))?\s*$/i

/**
 * Closing-reference patterns that the harness normalizes to a single
 * `Closes #<n>` line (issue keywords GitHub recognizes).
 */
// Whole-line close/fix/resolve refs (optional list marker / trailing punctuation).
const CLOSING_REFERENCE_LINE =
  /^(?:[-*]\s+)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\s*[.:]?\s*$/i

const GENERIC_PLACEHOLDER_BODY =
  /^Automated draft pull request for GitHub issue #\d+\.?$/i

/**
 * Parse a unique final READY_FOR_AGENT_RESULT: PUBLICATION_COPY line with JSON
 * payload `{"title":"...","body":"..."}`. Accepts the JSON on the result line
 * or as the sole non-empty content immediately before the result line.
 * Returns null for missing, blank, malformed, duplicate, or ambiguous results.
 */
export const parsePublicationCopyResult = (
  output: string,
): PublicationCopy | null => {
  const lines = output.split("\n").map((line) => line.trimEnd())
  const nonEmptyLines = lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
  const resultLines = nonEmptyLines.filter((line) =>
    /^READY_FOR_AGENT_RESULT:\s*PUBLICATION_COPY\b/i.test(line),
  )
  const finalLine = nonEmptyLines.at(-1)

  if (
    resultLines.length !== 1 ||
    finalLine === undefined ||
    finalLine !== resultLines[0]
  ) {
    return null
  }

  const match = RESULT_LINE.exec(finalLine)
  if (match === null) {
    return null
  }

  let jsonText = match[1]?.trim() ?? ""
  if (jsonText === "") {
    // Allow a JSON object as the only preceding content (possibly fenced).
    const preceding = nonEmptyLines.slice(0, -1)
    if (preceding.length === 0) {
      return null
    }
    const joined = preceding.join("\n").trim()
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(joined)
    jsonText = (fenced?.[1] ?? joined).trim()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText) as unknown
  } catch {
    return null
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("title" in parsed) ||
    !("body" in parsed)
  ) {
    return null
  }

  const title = (parsed as { title: unknown }).title
  const body = (parsed as { body: unknown }).body
  if (typeof title !== "string" || typeof body !== "string") {
    return null
  }

  return { title, body }
}

const stripClosingReferences = (body: string, issueNumber: number): string => {
  const kept: string[] = []
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    const match = CLOSING_REFERENCE_LINE.exec(trimmed)
    if (match !== null && Number(match[1]) === issueNumber) {
      continue
    }
    kept.push(line)
  }
  // Collapse trailing blank lines left by stripped closing refs.
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") {
    kept.pop()
  }
  return kept.join("\n").trim()
}

/**
 * Normalize agent copy: trim, enforce length bounds, require substantive body,
 * and ensure exactly one `Closes #<issue>` line. Returns null when invalid.
 */
export const normalizePublicationCopy = (
  raw: PublicationCopy,
  issueNumber: number,
): PublicationCopy | null => {
  const title = raw.title.replace(/\s+/g, " ").trim()
  if (title === "" || title.length > PUBLICATION_TITLE_MAX_LENGTH) {
    return null
  }

  const withoutCloses = stripClosingReferences(raw.body, issueNumber)
  if (withoutCloses === "") {
    return null
  }
  if (GENERIC_PLACEHOLDER_BODY.test(withoutCloses)) {
    return null
  }
  // Substantive: more than a single trivial token/line of punctuation.
  if (withoutCloses.replace(/[\s#\d.,;:!?\-_/\\'"`()[\]]+/g, "").length < 8) {
    return null
  }

  const closesLine = `Closes #${issueNumber}`
  const body = `${withoutCloses}\n\n${closesLine}`
  if (body.length > PUBLICATION_BODY_MAX_LENGTH) {
    return null
  }

  return { title, body }
}

/** Build the full commit message from canonical publication copy. */
export const formatPublicationCommitMessage = (copy: PublicationCopy): string =>
  `${copy.title}\n\n${copy.body}`

/**
 * Parse a native git commit message (`%B`) into title + body for seeding
 * in-flight Work Items that committed before publication fields existed.
 */
export const publicationCopyFromCommitMessage = (
  message: string,
  issueNumber: number,
): PublicationCopy | null => {
  const trimmed = message.replace(/\r\n/g, "\n").trim()
  if (trimmed === "") {
    return null
  }
  const parts = trimmed.split("\n")
  const title = (parts[0] ?? "").trim()
  const body = parts.slice(1).join("\n").replace(/^\n+/, "").trim()
  // Seed path is more permissive: accept whatever the actual commit contains
  // as long as title is nonblank; still normalize the closing reference.
  if (title === "") {
    return null
  }
  // Prefer equality with the actual commit: strip duplicate closing refs and
  // re-append exactly one. Do not invent prose when the body was empty or only
  // closes (legacy `title\n\nCloses #N` → body is just `Closes #N`).
  const stripped = body === "" ? "" : stripClosingReferences(body, issueNumber)
  const prose = stripped.trim()
  const normalizedBody =
    prose === ""
      ? `Closes #${issueNumber}`
      : `${prose}\n\nCloses #${issueNumber}`
  if (title.length > PUBLICATION_TITLE_MAX_LENGTH) {
    return {
      title: title.slice(0, PUBLICATION_TITLE_MAX_LENGTH).trimEnd(),
      body: normalizedBody.slice(0, PUBLICATION_BODY_MAX_LENGTH),
    }
  }
  return {
    title,
    body:
      normalizedBody.length > PUBLICATION_BODY_MAX_LENGTH
        ? normalizedBody.slice(0, PUBLICATION_BODY_MAX_LENGTH)
        : normalizedBody,
  }
}

export const buildPublicationCopyPrompt = (issueNumber: number): string =>
  [
    "Author shared publication copy for this Work Item's git commit and draft pull request.",
    "Use the completed implementation, Review remediation, and verification already present in this Session.",
    "Write copy only. Do not edit files, stage, commit, push, open or edit pull requests, or run mutating git commands.",
    "Produce:",
    "- title: a concise title describing the actual net change; follow this repository's conventions (for example Conventional Commits when the repo uses them).",
    "- body: useful reviewer-facing Markdown explaining why the change was needed, what changed, and meaningful verification or limitations.",
    "Do not use the Issue title alone as the publication title.",
    'Do not write a generic body such as "Automated draft pull request for GitHub issue #N".',
    `You may mention issue #${issueNumber}; the harness will ensure the body ends with exactly one Closes #${issueNumber} reference.`,
    "End your final response with exactly one machine-readable result line. Prefer putting the JSON on that line:",
    `READY_FOR_AGENT_RESULT: PUBLICATION_COPY {"title":"...","body":"..."}`,
    "The body value must be a JSON string (use \\n for newlines). The result line must be the final non-empty line.",
  ].join("\n")

export const buildPublicationCopyFormatCorrectionPrompt = (
  issueNumber: number,
): string =>
  [
    "Your previous response did not report a unique final READY_FOR_AGENT_RESULT: PUBLICATION_COPY with valid JSON title and body.",
    "Reply with copy only — do not edit files, stage, commit, push, or create a pull request.",
    `End with exactly one final line of the form: READY_FOR_AGENT_RESULT: PUBLICATION_COPY {"title":"...","body":"..."}`,
    `Include a substantive title and body for the completed work on issue #${issueNumber}.`,
  ].join("\n")

export const buildCreatePrFallbackPromptWithCopy = (input: {
  readonly issueNumber: number
  readonly branch: string
  readonly title: string
  readonly body: string
  readonly credentialGuidance: string
  readonly diagnostics: string
}): string =>
  [
    "The harness attempted to open a draft pull request for the committed work in this worktree and failed.",
    "Repair the underlying problem (authentication, push, repository PR templates, or content requirements) and create the draft PR.",
    `The current Work Item branch is ${input.branch}. Keep this branch checked out and use it as the pull request head.`,
    "Do not create or switch to another branch.",
    "Push this exact branch if needed, then open a PR against the repository default base branch.",
    "Create the pull request as a draft.",
    "Use this exact title and body — do not invent different publication copy:",
    promptUserContentSection("publication_title", input.title),
    promptUserContentSection("publication_body", input.body),
    `If a suitable open PR whose head is exactly ${input.branch} already exists, succeed without creating a duplicate; if it is still a draft, update its title and body to match the copy above.`,
    "Do not merge the pull request.",
    input.credentialGuidance,
    "",
    "Bounded native failure diagnostics:",
    promptUserContentSection("diagnostics", input.diagnostics),
  ].join("\n")

export const buildCommitFallbackPromptWithCopy = (input: {
  readonly issueNumber: number
  readonly title: string
  readonly body: string
  readonly diagnostics: string
}): string =>
  [
    "The harness attempted to create a git commit for the implementation changes in this worktree and failed.",
    "Repair the underlying problem and create the commit yourself.",
    "Prefer this exact commit message (subject + body). Only change the message if repository policy (for example commitlint) requires a different form:",
    promptUserContentSection("publication_title", input.title),
    promptUserContentSection("publication_body", input.body),
    `The commit must still close GitHub issue #${input.issueNumber} (include Closes #${input.issueNumber} in the body unless policy forbids it — then mention the issue another accepted way).`,
    "Stage only the relevant implementation changes, then commit.",
    "Exclude harness-owned diagnostic artifacts such as `.ready-for-agent/`.",
    "If there is nothing left to commit because a valid commit already exists for this work, succeed without creating an empty commit.",
    "Do not open a pull request.",
    "",
    "Bounded native failure diagnostics:",
    promptUserContentSection("diagnostics", input.diagnostics),
  ].join("\n")
