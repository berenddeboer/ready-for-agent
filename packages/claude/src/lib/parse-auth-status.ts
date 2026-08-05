/**
 * Claude Code `apiProvider` as reported by `claude auth status` JSON.
 * Used for readiness classification (first-party vs Amazon Bedrock, issue #801).
 * Unknown when the field is absent or not a recognized value.
 */
export type ClaudeAuthProvider = "firstParty" | "bedrock" | "unknown"

export type ClaudeAuthStatus =
  | { readonly kind: "authenticated"; readonly provider: ClaudeAuthProvider }
  | { readonly kind: "unauthenticated"; readonly provider: ClaudeAuthProvider }
  | { readonly kind: "malformed" }
  | { readonly kind: "failed"; readonly exitCode: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Map Claude’s reported `apiProvider` string. Classification uses this field
 * (and `loggedIn`), never “missing claude.ai login implies Bedrock”.
 */
export const readClaudeAuthProvider = (value: unknown): ClaudeAuthProvider => {
  if (value === "bedrock") {
    return "bedrock"
  }
  if (value === "firstParty") {
    return "firstParty"
  }
  return "unknown"
}

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
 * Real CLI shapes:
 * - First-party ready: `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",...}`
 * - Bedrock ready: `{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}`
 * - Unauthenticated: `loggedIn: false` (often exit non-zero), first-party path
 *
 * Classification prefers JSON `loggedIn` plus `apiProvider` so:
 * - Bedrock third-party auth is Ready when Claude reports it
 * - Missing claude.ai login is never inferred as Bedrock
 * - A crash without `loggedIn` is not mistaken for missing auth
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
        const provider = readClaudeAuthProvider(parsed.apiProvider)
        // Ready for first-party OAuth/API key and for Bedrock third-party when
        // Claude reports loggedIn true (verified Bedrock shape uses
        // apiProvider "bedrock" + authMethod "third_party").
        return parsed.loggedIn
          ? { kind: "authenticated", provider }
          : { kind: "unauthenticated", provider }
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
    return { kind: "unauthenticated", provider: "unknown" }
  }
  // Positive phrases only — no `/authenticated/` (matches "unauthenticated")
  // and no field-name heuristics like `/authMethod/`.
  if (/\blogged in\b/i.test(trimmed)) {
    return { kind: "authenticated", provider: "unknown" }
  }

  if (exitCode !== 0) {
    return { kind: "failed", exitCode }
  }
  return { kind: "malformed" }
}
