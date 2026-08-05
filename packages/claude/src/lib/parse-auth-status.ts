export type ClaudeAuthStatus =
  | { readonly kind: "authenticated" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "malformed" }
  | { readonly kind: "failed"; readonly exitCode: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Extract the first balanced JSON object from mixed CLI capture text so trailing
 * stderr noise after a valid `auth status` object does not break `JSON.parse`.
 */
export const extractFirstJsonObject = (text: string): string | undefined => {
  const start = text.indexOf("{")
  if (start < 0) {
    return undefined
  }

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (char === undefined) {
      break
    }
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") {
      depth += 1
    } else if (char === "}") {
      depth -= 1
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }
  return undefined
}

/**
 * Interpret `claude auth status` captured text (JSON default) plus exit code.
 *
 * Real CLI: authenticated exits 0 with `{"loggedIn":true,...}`; unauthenticated
 * reports `loggedIn: false` (often exit non-zero). Classification prefers the
 * JSON `loggedIn` field so a crash without that field is not mistaken for
 * missing auth.
 */
export const parseClaudeAuthStatus = (
  output: string,
  exitCode: number,
): ClaudeAuthStatus => {
  const trimmed = output.trim()
  if (trimmed.length === 0) {
    return exitCode === 0 ? { kind: "malformed" } : { kind: "failed", exitCode }
  }

  // Prefer the first balanced JSON object in the capture (stdout or mixed).
  const jsonObject = extractFirstJsonObject(trimmed)
  if (jsonObject !== undefined) {
    try {
      const parsed: unknown = JSON.parse(jsonObject)
      if (isRecord(parsed) && typeof parsed.loggedIn === "boolean") {
        return parsed.loggedIn
          ? { kind: "authenticated" }
          : { kind: "unauthenticated" }
      }
    } catch {
      // Fall through to marker / exit-code paths.
    }
  }

  // Human-readable fallbacks (e.g. `claude auth status --text`).
  // Unauth markers first so "not authenticated" never matches a positive.
  if (
    /not (?:logged|signed) in/i.test(trimmed) ||
    /\bunauthenticated\b/i.test(trimmed) ||
    /you are not authenticated/i.test(trimmed) ||
    /not authenticated/i.test(trimmed) ||
    /authentication required/i.test(trimmed) ||
    /please (?:log|sign) in/i.test(trimmed)
  ) {
    return { kind: "unauthenticated" }
  }
  // Positive phrases only — no `/authenticated/` (matches "unauthenticated")
  // and no field-name heuristics like `/authMethod/`.
  if (/\blogged in\b/i.test(trimmed)) {
    return { kind: "authenticated" }
  }

  if (exitCode !== 0) {
    return { kind: "failed", exitCode }
  }
  return { kind: "malformed" }
}
