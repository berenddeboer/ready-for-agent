/**
 * Shared READY_FOR_AGENT_RESULT candidate extraction for lifecycle parsers.
 *
 * Agent prose and machine control outcomes are separate: candidates are
 * normalized, unknown names are never mapped to a known outcome, and the last
 * valid known marker wins.
 */

/** Bound persisted/displayed result-looking lines (not the full response). */
export const RESULT_CANDIDATE_CHAR_LIMIT = 500

export type ResultLineFailureKind =
  | "missing"
  | "unknown_result"
  | "invalid_argument"
  | "invalid_payload"

const RESULT_PREFIX = /^READY_FOR_AGENT_RESULT:/i
const RESULT_NAME = /^READY_FOR_AGENT_RESULT:\s*([A-Za-z0-9_]+)/i
const INLINE_CODE_LINE = /^`([^`]+)`$/

/**
 * Trim whitespace and unwrap exactly one Markdown inline-code wrapper.
 * Fenced blocks and unmatched backticks are left as-is.
 */
export const normalizeResultCandidateLine = (line: string): string => {
  const trimmed = line.trim()
  const wrapped = INLINE_CODE_LINE.exec(trimmed)
  if (wrapped?.[1] === undefined) {
    return trimmed
  }
  return wrapped[1].trim()
}

export const isResultLookingLine = (line: string): boolean =>
  RESULT_PREFIX.test(normalizeResultCandidateLine(line))

/** Result-looking lines in output order, after normalization. */
export const resultCandidateLines = (output: string): string[] =>
  output
    .split("\n")
    .map(normalizeResultCandidateLine)
    .filter((line) => RESULT_PREFIX.test(line))

export const lastNormalizedResultCandidate = (output: string): string | null =>
  resultCandidateLines(output).at(-1) ?? null

export const boundResultCandidate = (line: string): string =>
  line.length <= RESULT_CANDIDATE_CHAR_LIMIT
    ? line
    : `${line.slice(0, RESULT_CANDIDATE_CHAR_LIMIT)}…`

export const resultNameFromLine = (line: string): string | null => {
  const match = RESULT_NAME.exec(normalizeResultCandidateLine(line))
  return match?.[1] === undefined ? null : match[1].toUpperCase()
}

/**
 * Last candidate that `tryParseLine` accepts. Earlier invalid or superseded
 * candidates and surrounding prose are ignored.
 */
export const lastValidResult = <T>(
  output: string,
  tryParseLine: (line: string) => T | null,
): T | null => {
  let result: T | null = null
  for (const line of resultCandidateLines(output)) {
    const parsed = tryParseLine(line)
    if (parsed !== null) {
      result = parsed
    }
  }
  return result
}

export const classifyUnparsedResult = (
  output: string,
  knownNames: ReadonlySet<string>,
  options: { readonly payloadName?: string } = {},
): {
  readonly kind: ResultLineFailureKind
  readonly lastCandidate: string | null
} => {
  const lastCandidate = lastNormalizedResultCandidate(output)
  if (lastCandidate === null) {
    return { kind: "missing", lastCandidate: null }
  }
  const name = resultNameFromLine(lastCandidate)
  if (name === null || !knownNames.has(name)) {
    return { kind: "unknown_result", lastCandidate }
  }
  if (
    options.payloadName !== undefined &&
    name === options.payloadName.toUpperCase()
  ) {
    return { kind: "invalid_payload", lastCandidate }
  }
  return { kind: "invalid_argument", lastCandidate }
}

export const quotedResultCandidateSuffix = (output: string): string => {
  const last = lastNormalizedResultCandidate(output)
  return last === null
    ? ""
    : ` (got ${JSON.stringify(boundResultCandidate(last))})`
}

export const formatResultLineFailure = (
  kind: ResultLineFailureKind,
  lastCandidate: string | null,
): string => {
  const quoted =
    lastCandidate === null
      ? ""
      : ` (got ${JSON.stringify(boundResultCandidate(lastCandidate))})`
  switch (kind) {
    case "missing":
      return "missing result line"
    case "unknown_result":
      return `unknown result${quoted}`
    case "invalid_argument":
      return `invalid argument${quoted}`
    case "invalid_payload":
      return `invalid payload${quoted}`
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}
