import type { AgentBackendProvider } from "./types.js"

/** Shared suffix of `CLAUDE_BEDROCK_UNAVAILABLE_MESSAGE`. */
export const CLAUDE_BEDROCK_CREDENTIAL_REMEDIATION =
  "Ensure valid AWS credentials and region are available to the harness process (with CLAUDE_CODE_USE_BEDROCK=1), then Recheck Agent Backend."

/** Shared with Claude Code first-party readiness copy. */
export const CLAUDE_FIRST_PARTY_AUTH_REMEDIATION =
  "Run `claude auth login` (or set `ANTHROPIC_API_KEY`), then Recheck Agent Backend."

const GENERIC_CREDENTIAL_REMEDIATION =
  "Refresh credentials for the harness process, then Recheck Agent Backend."

const AWS_CREDENTIAL_REMEDIATION =
  "Ensure valid AWS credentials and region are available to the harness process, then Recheck Agent Backend."

const AMAZON_BEDROCK_PROVIDER = {
  id: "bedrock",
  label: "Amazon Bedrock",
} as const satisfies AgentBackendProvider

const AWS_PROVIDER = {
  id: "aws",
  label: "AWS",
} as const satisfies AgentBackendProvider

/**
 * Provider credential markers recognized from AWS SDK / Bedrock / CLI
 * failure text. Single source for catalog discovery and mid-turn
 * `terminal_auth_error` classification.
 */
const PROVIDER_CREDENTIAL_MARKERS = [
  "expiredtoken",
  "expired token",
  "token has expired",
  "token is expired",
  "could not load credentials",
  "credentials not found",
  "unable to locate credentials",
  "could not load credentials from any providers",
  "security token",
  "invalidclienttokenid",
  "unrecognizedclient",
  "invalididentitytoken",
  "sso session",
] as const

export type ProviderCredentialClassification = {
  readonly classification: "terminal_auth_error"
  readonly provider: AgentBackendProvider | null
}

/**
 * Strip access keys, session tokens, bearer tokens, and other credential-like
 * payloads from operator-facing failure text (issue #822 / #1058).
 */
export const scrubProviderCredentialSecrets = (text: string): string => {
  let scrubbed = text
  // IAM access key ids (long-term AKIA… and temporary ASIA…).
  scrubbed = scrubbed.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
  // Env-style, property-style, and JSON-ish secret field assignments.
  scrubbed = scrubbed.replace(
    /\b(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_BEARER_TOKEN_BEDROCK|AWS_ACCESS_KEY_ID|aws_secret_access_key|aws_session_token|aws_access_key_id|secretAccessKey|SecretAccessKey|accessKeyId|AccessKeyId|sessionToken|SessionToken|security.?token)\b\s*[=:]\s*"?[^"\s,}]+"?/gi,
    (match) => {
      const keyMatch = match.match(/^([^=:]+)/)
      const key = (keyMatch?.[1] ?? "secret").trim()
      const separator = match.includes("=") ? "=" : ":"
      return `${key}${separator}[redacted]`
    },
  )
  // JSON `"secretAccessKey": "…"` / `"accessKeyId":"…"` forms.
  scrubbed = scrubbed.replace(
    /"(?:secretAccessKey|SecretAccessKey|accessKeyId|AccessKeyId|sessionToken|SessionToken|aws_secret_access_key|aws_session_token|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_ACCESS_KEY_ID)"\s*:\s*"[^"]*"/gi,
    (match) => {
      const keyMatch = match.match(/^"([^"]+)"/)
      const key = keyMatch?.[1] ?? "secret"
      return `"${key}":"[redacted]"`
    },
  )
  // Authorization / bearer headers.
  scrubbed = scrubbed.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    "Bearer [redacted]",
  )
  return scrubbed
}

const mentionsBedrock = (normalized: string): boolean =>
  normalized.includes("bedrock") || normalized.includes("amazon bedrock")

const hasProviderCredentialMarker = (normalized: string): boolean =>
  PROVIDER_CREDENTIAL_MARKERS.some((marker) => normalized.includes(marker))

/**
 * Recognize a provider rejecting credentials from failure text (stderr,
 * JSONL error, AWS SDK exception). Unrecognized text returns undefined so
 * callers keep generic handling.
 */
export const classifyProviderCredentialText = (
  text: string,
): ProviderCredentialClassification | undefined => {
  const normalized = scrubProviderCredentialSecrets(text).toLowerCase()
  if (!hasProviderCredentialMarker(normalized)) {
    return undefined
  }
  return {
    classification: "terminal_auth_error",
    provider: mentionsBedrock(normalized)
      ? AMAZON_BEDROCK_PROVIDER
      : AWS_PROVIDER,
  }
}

export const formatTerminalAuthErrorMessage = (input: {
  readonly backendLabel: string
  readonly provider?: AgentBackendProvider | null
}): string => {
  const provider = input.provider
  const namedProvider =
    provider?.id === "firstParty" ? undefined : provider?.label?.trim()
  const named =
    namedProvider !== undefined && namedProvider.length > 0
      ? `${input.backendLabel} could not authenticate to ${namedProvider}`
      : `${input.backendLabel} could not authenticate`
  const subject = `${named} (credentials missing or expired)`

  if (provider?.id === "bedrock") {
    return `${subject}. ${CLAUDE_BEDROCK_CREDENTIAL_REMEDIATION}`
  }
  if (provider?.id === "firstParty") {
    return `${subject}. ${CLAUDE_FIRST_PARTY_AUTH_REMEDIATION}`
  }
  if (provider?.id === "aws") {
    return `${subject}. ${AWS_CREDENTIAL_REMEDIATION}`
  }
  return `${subject}. ${GENERIC_CREDENTIAL_REMEDIATION}`
}
