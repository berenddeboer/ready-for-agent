/**
 * Shared Commit and Create PR publication copy: parse, normalize, and bound
 * agent-authored title/body used identically for git commit and draft PR.
 */

import { basename, extname, isAbsolute, relative, resolve } from "node:path"
import { currentNativeForgeClosingReferenceRules } from "@ready-for-agent/forge-contract"
import type { IssueSource } from "@ready-for-agent/lifecycle-model"
import { isLinearIssueSource } from "./linear-milestones.js"
import {
  classifyUnparsedResult,
  normalizeResultCandidateLine,
} from "./result-line.js"
import { promptUserContentSection } from "./sanitize-prompt-user-content.js"

const closingReference = currentNativeForgeClosingReferenceRules

const linearReferenceLines = (source: IssueSource): readonly string[] => [
  `Linear: ${source.displayId}`,
  source.url,
]

const stripLinearReference = (body: string, source: IssueSource): string => {
  const kept: string[] = []
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" && kept.length === 0) {
      continue
    }
    if (trimmed === source.url) {
      continue
    }
    if (trimmed === `Linear: ${source.displayId}`) {
      continue
    }
    if (trimmed === source.displayId) {
      continue
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") {
    kept.pop()
  }
  return kept.join("\n").trim()
}

export const formatPublicationIssueReference = (
  issueNumber: number,
  issueSource?: IssueSource,
): string =>
  isLinearIssueSource(issueSource)
    ? linearReferenceLines(issueSource).join("\n")
    : closingReference.formatLine(issueNumber)

const stripPublicationIssueReference = (
  body: string,
  issueNumber: number,
  issueSource?: IssueSource,
): string => {
  const withoutCloses = closingReference.strip(body, issueNumber)
  return isLinearIssueSource(issueSource)
    ? stripLinearReference(withoutCloses, issueSource)
    : withoutCloses
}

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

const PUBLICATION_COPY_NAMES = new Set(["PUBLICATION_COPY"])

const decodePublicationCopyJson = (
  jsonText: string,
): PublicationCopy | null => {
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

const attachedJsonBeforeCandidate = (
  rawLines: readonly string[],
  candidateIndex: number,
): string | null => {
  const attached: string[] = []
  for (let i = candidateIndex - 1; i >= 0; i -= 1) {
    const normalized = normalizeResultCandidateLine(rawLines[i] ?? "")
    if (normalized === "") {
      continue
    }
    if (/^READY_FOR_AGENT_RESULT:/i.test(normalized)) {
      break
    }
    attached.unshift(rawLines[i] ?? "")
  }
  if (attached.length === 0) {
    return null
  }
  const joined = attached.join("\n").trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(joined)
  return (fenced?.[1] ?? joined).trim()
}

const tryParsePublicationCopyLine = (
  line: string,
  attachedJson: string | null,
): PublicationCopy | null => {
  const match = RESULT_LINE.exec(line)
  if (match === null) {
    return null
  }

  let jsonText = match[1]?.trim() ?? ""
  if (jsonText === "") {
    if (attachedJson === null || attachedJson === "") {
      return null
    }
    jsonText = attachedJson
  }

  return decodePublicationCopyJson(jsonText)
}

/**
 * Parse the last valid READY_FOR_AGENT_RESULT: PUBLICATION_COPY marker with
 * JSON payload `{"title":"...","body":"..."}`. Accepts the JSON on the result
 * line or as the sole attached content immediately before that candidate.
 * Trailing prose and earlier malformed candidates are ignored. Returns null
 * when no candidate parses as a known PUBLICATION_COPY payload.
 */
export const parsePublicationCopyResult = (
  output: string,
): PublicationCopy | null => {
  const rawLines = output.split("\n")
  let result: PublicationCopy | null = null
  for (const [index, raw] of rawLines.entries()) {
    const line = normalizeResultCandidateLine(raw)
    if (!/^READY_FOR_AGENT_RESULT:\s*PUBLICATION_COPY\b/i.test(line)) {
      continue
    }
    const parsed = tryParsePublicationCopyLine(
      line,
      attachedJsonBeforeCandidate(rawLines, index),
    )
    if (parsed !== null) {
      result = parsed
    }
  }
  return result
}

export const inspectPublicationCopyResult = (output: string) => {
  const parsed = parsePublicationCopyResult(output)
  if (parsed !== null) {
    return { parsed, failure: null } as const
  }
  return {
    parsed: null,
    failure: classifyUnparsedResult(output, PUBLICATION_COPY_NAMES, {
      payloadName: "PUBLICATION_COPY",
    }),
  } as const
}

/**
 * Normalize agent copy: trim, enforce length bounds, require substantive body,
 * and ensure exactly one Issue reference. Forge-hosted Issues keep
 * `Closes #<issue>`; Linear Issues get the display key and URL instead of a
 * fabricated GitHub closing reference. Returns null when invalid.
 */
export const normalizePublicationCopy = (
  raw: PublicationCopy,
  issueNumber: number,
  issueSource?: IssueSource,
): PublicationCopy | null => {
  const title = raw.title.replace(/\s+/g, " ").trim()
  if (title === "" || title.length > PUBLICATION_TITLE_MAX_LENGTH) {
    return null
  }

  const withoutCloses = stripPublicationIssueReference(
    raw.body,
    issueNumber,
    issueSource,
  )
  if (withoutCloses === "") {
    return null
  }
  if (closingReference.isGenericPlaceholder(withoutCloses)) {
    return null
  }
  // Substantive: more than a single trivial token/line of punctuation.
  if (withoutCloses.replace(/[\s#\d.,;:!?\-_/\\'"`()[\]]+/g, "").length < 8) {
    return null
  }

  const body = `${withoutCloses}\n\n${formatPublicationIssueReference(issueNumber, issueSource)}`
  if (body.length > PUBLICATION_BODY_MAX_LENGTH) {
    return null
  }

  return { title, body }
}

/** Build the full commit message from canonical publication copy. */
export const formatPublicationCommitMessage = (copy: PublicationCopy): string =>
  `${copy.title}\n\n${copy.body}`

export const PUBLICATION_COPY_SOURCE = {
  agent: "agent",
  harnessFallback: "harness_fallback",
} as const

export type PublicationCopySource =
  (typeof PUBLICATION_COPY_SOURCE)[keyof typeof PUBLICATION_COPY_SOURCE]

const HARNESS_FALLBACK_BODY_PREFIX = "Harness publication-copy fallback"

export const isHarnessPublicationFallbackCopy = (
  copy: PublicationCopy,
): boolean => copy.body.startsWith(HARNESS_FALLBACK_BODY_PREFIX)

/** Harness-owned copy when both publication-copy Agent Turns fail. */
export const buildHarnessPublicationFallbackCopy = (input: {
  readonly issueNumber: number
  readonly issueTitle: string | null
  readonly workItemId: string
  readonly issueSource?: IssueSource
}): PublicationCopy => {
  const trimmedTitle = (input.issueTitle ?? "").replace(/\s+/g, " ").trim()
  const linear = isLinearIssueSource(input.issueSource)
  const title =
    trimmedTitle === ""
      ? linear
        ? `Implement ${input.issueSource.displayId}`
        : `Implement issue #${input.issueNumber}`
      : trimmedTitle.slice(0, PUBLICATION_TITLE_MAX_LENGTH)
  const body = [
    `${HARNESS_FALLBACK_BODY_PREFIX} for Work Item ${input.workItemId}.`,
    "The agent did not emit valid publication copy. Review the linked Issue and this commit diff.",
    "",
    formatPublicationIssueReference(input.issueNumber, input.issueSource),
  ].join("\n")
  return { title, body }
}

const ATTACHMENT_IMAGE_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

export type AttachmentImageCandidate = {
  readonly filePath: string
  readonly name: string
  readonly contentType: string
}

const MARKDOWN_IMAGE =
  /!\[(?:[^\]]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g

const stripAngleBrackets = (destination: string): string => {
  const trimmed = destination.trim()
  if (trimmed.startsWith("<") && trimmed.endsWith(">") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

const decodeDestination = (destination: string): string => {
  const stripped = stripAngleBrackets(destination)
  if (stripped === "") {
    return ""
  }
  try {
    return decodeURIComponent(stripped)
  } catch {
    return stripped
  }
}

const pathFromFileUrl = (destination: string): string | null => {
  if (!destination.startsWith("file:")) {
    return null
  }
  try {
    return new URL(destination).pathname
  } catch {
    return destination.replace(/^file:\/\//, "")
  }
}

const isRemoteDestination = (destination: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(destination) && !destination.startsWith("file:")

const isInsideDirectory = (filePath: string, directory: string): boolean => {
  const relativePath = relative(directory, filePath)
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  )
}

/** Destinations of markdown images in publication-copy body text, raw. */
export const listMarkdownImageDestinations = (
  body: string,
): readonly string[] => {
  const destinations: string[] = []
  const pattern = new RegExp(MARKDOWN_IMAGE.source, MARKDOWN_IMAGE.flags)
  for (const match of body.matchAll(pattern)) {
    const destination = match[1]
    if (destination !== undefined && destination !== "") {
      destinations.push(destination)
    }
  }
  return destinations
}

/**
 * Resolve a markdown image destination to an in-directory png/jpeg/gif/webp
 * file. Returns null for remotes, other types, or any path that escapes the
 * Work Item attachment directory.
 */
export const resolveAttachmentImageCandidate = (input: {
  readonly destination: string
  readonly attachmentDirectory: string
}): AttachmentImageCandidate | null => {
  const decoded = decodeDestination(input.destination)
  if (decoded === "") {
    return null
  }
  const asFileUrl = pathFromFileUrl(decoded)
  const localPath = asFileUrl ?? (isRemoteDestination(decoded) ? null : decoded)
  if (localPath === null || localPath === "") {
    return null
  }

  const attachmentRoot = resolve(input.attachmentDirectory)
  const resolved = isAbsolute(localPath)
    ? resolve(localPath)
    : resolve(attachmentRoot, localPath)
  if (!isInsideDirectory(resolved, attachmentRoot)) {
    return null
  }

  const contentType =
    ATTACHMENT_IMAGE_CONTENT_TYPES[extname(resolved).toLowerCase()]
  if (contentType === undefined) {
    return null
  }
  return {
    filePath: resolved,
    name: basename(resolved),
    contentType,
  }
}

/** Replace markdown image destinations whose raw text is a map key. */
export const replaceMarkdownImageDestinations = (
  body: string,
  replacements: ReadonlyMap<string, string>,
): string => {
  if (replacements.size === 0) {
    return body
  }
  const pattern = new RegExp(MARKDOWN_IMAGE.source, MARKDOWN_IMAGE.flags)
  return body.replace(pattern, (match, destination: string) => {
    const replacement = replacements.get(destination)
    if (replacement === undefined) {
      return match
    }
    const destIntro = match.indexOf("](")
    if (destIntro === -1) {
      return match
    }
    const afterOpen = match.slice(destIntro + 2)
    const leadingWhitespace = /^\s*/.exec(afterOpen)?.[0] ?? ""
    const destAt = destIntro + 2 + leadingWhitespace.length
    if (match.slice(destAt, destAt + destination.length) !== destination) {
      return match
    }
    return (
      match.slice(0, destAt) +
      replacement +
      match.slice(destAt + destination.length)
    )
  })
}

/**
 * Parse a native git commit message (`%B`) into title + body for seeding
 * in-flight Work Items that committed before publication fields existed.
 */
export const publicationCopyFromCommitMessage = (
  message: string,
  issueNumber: number,
  issueSource?: IssueSource,
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
  const stripped =
    body === ""
      ? ""
      : stripPublicationIssueReference(body, issueNumber, issueSource)
  const prose = stripped.trim()
  const reference = formatPublicationIssueReference(issueNumber, issueSource)
  const normalizedBody = prose === "" ? reference : `${prose}\n\n${reference}`
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

export const buildPublicationCopyPrompt = (input: {
  readonly issueNumber: number
  readonly attachmentDirectory: string
  readonly issueSource?: IssueSource
}): string =>
  [
    "Author shared publication copy for this Work Item's git commit and draft pull request.",
    "Use the completed implementation, Review remediation, and verification already present in this Session.",
    "Write copy only. Do not edit files, stage, commit, push, open or edit pull requests, or run mutating git commands.",
    `Work Item attachment directory: ${input.attachmentDirectory}`,
    "You may embed markdown images that point at files in that directory. Do not invent other local paths.",
    "Produce:",
    "- title: a concise title describing the actual net change; follow this repository's conventions (for example Conventional Commits when the repo uses them).",
    "- body: useful reviewer-facing Markdown explaining why the change was needed, what changed, and meaningful verification or limitations.",
    "Do not use the Issue title alone as the publication title.",
    `Do not write a generic body such as "${closingReference.genericPlaceholderExample}".`,
    isLinearIssueSource(input.issueSource)
      ? `Reference Linear issue ${input.issueSource.displayId} (${input.issueSource.url}); the harness will ensure the body ends with that Linear identity. Do not write a GitHub Closes #<number> line.`
      : closingReference.mentionGuidance(input.issueNumber),
    "End your final response with exactly one machine-readable result line. Prefer putting the JSON on that line:",
    `READY_FOR_AGENT_RESULT: PUBLICATION_COPY {"title":"...","body":"..."}`,
    "The body value must be a JSON string (use \\n for newlines). The result line must be the final non-empty line.",
  ].join("\n")

export const buildPublicationCopyFormatCorrectionPrompt = (input: {
  readonly issueNumber: number
  readonly attachmentDirectory: string
  readonly issueSource?: IssueSource
}): string =>
  [
    "Your previous response did not report a unique final READY_FOR_AGENT_RESULT: PUBLICATION_COPY with valid JSON title and body.",
    "Reply with copy only — do not edit files, stage, commit, push, or create a pull request.",
    `Work Item attachment directory: ${input.attachmentDirectory}`,
    "You may embed markdown images that point at files in that directory.",
    `End with exactly one final line of the form: READY_FOR_AGENT_RESULT: PUBLICATION_COPY {"title":"...","body":"..."}`,
    isLinearIssueSource(input.issueSource)
      ? `Include a substantive title and body for the completed work on Linear issue ${input.issueSource.displayId}. Do not write a GitHub Closes #<number> line.`
      : `Include a substantive title and body for the completed work on issue #${input.issueNumber}.`,
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
  readonly issueSource?: IssueSource
}): string =>
  [
    "The harness attempted to create a git commit for the implementation changes in this worktree and failed.",
    "Repair the underlying problem and create the commit yourself.",
    "Prefer this exact commit message (subject + body). Only change the message if repository policy (for example commitlint) requires a different form:",
    promptUserContentSection("publication_title", input.title),
    promptUserContentSection("publication_body", input.body),
    isLinearIssueSource(input.issueSource)
      ? `Keep the Linear issue ${input.issueSource.displayId} reference in the commit body. Do not add a GitHub Closes #<number> line.`
      : closingReference.commitMustCloseGuidance(input.issueNumber),
    "Stage only the relevant implementation changes, then commit.",
    "Exclude harness-owned diagnostic artifacts such as `.ready-for-agent/`.",
    "If there is nothing left to commit because a valid commit already exists for this work, succeed without creating an empty commit.",
    "Do not open a pull request.",
    "",
    "Bounded native failure diagnostics:",
    promptUserContentSection("diagnostics", input.diagnostics),
  ].join("\n")
