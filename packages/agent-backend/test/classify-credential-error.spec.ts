import {
  CLAUDE_BEDROCK_CREDENTIAL_REMEDIATION,
  CLAUDE_FIRST_PARTY_AUTH_REMEDIATION,
  classifyProviderCredentialText,
  formatTerminalAuthErrorMessage,
  scrubProviderCredentialSecrets,
} from "../src/lib/classify-credential-error.js"
import { describe, expect, it } from "bun:test"

describe("classifyProviderCredentialText", () => {
  it.each([
    "ExpiredTokenException",
    "The security token included in the request is expired",
    "token has expired",
    "token is expired",
    "expired token",
    "SSO session expired",
    "Could not load credentials from any providers",
    "credentials not found",
    "Unable to locate credentials",
    "InvalidClientTokenId",
    "UnrecognizedClientException",
    "InvalidIdentityToken",
  ])("classifies %s as terminal_auth_error", (text) => {
    expect(classifyProviderCredentialText(text)).toMatchObject({
      classification: "terminal_auth_error",
    })
  })

  it("names Amazon Bedrock when the failure text reports that provider", () => {
    expect(
      classifyProviderCredentialText(
        "Claude Code could not authenticate to Amazon Bedrock: ExpiredToken",
      ),
    ).toEqual({
      classification: "terminal_auth_error",
      provider: { id: "bedrock", label: "Amazon Bedrock" },
    })
  })

  it("names AWS when only credential markers are present", () => {
    expect(
      classifyProviderCredentialText(
        "ExpiredTokenException: The security token included in the request is expired",
      ),
    ).toEqual({
      classification: "terminal_auth_error",
      provider: { id: "aws", label: "AWS" },
    })
  })

  it("does not classify a generic step failure", () => {
    expect(
      classifyProviderCredentialText(
        "Claude Code fallback failed to install dependencies",
      ),
    ).toBeUndefined()
    expect(
      classifyProviderCredentialText("npm install failed: EACCES"),
    ).toBeUndefined()
    expect(
      classifyProviderCredentialText("AccessDeniedException"),
    ).toBeUndefined()
  })
})

describe("scrubProviderCredentialSecrets", () => {
  it("redacts access keys and secret payloads", () => {
    const dirty =
      "request failed using AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY=supersecretvalue AWS_SESSION_TOKEN=sessiontok"
    const clean = scrubProviderCredentialSecrets(dirty)
    expect(clean).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(clean).not.toContain("supersecretvalue")
    expect(clean).not.toContain("sessiontok")
    expect(clean).toContain("[redacted]")
  })
})

describe("formatTerminalAuthErrorMessage", () => {
  it("names Claude Code and Amazon Bedrock with the readiness remediation", () => {
    expect(
      formatTerminalAuthErrorMessage({
        backendLabel: "Claude Code",
        provider: { id: "bedrock", label: "Amazon Bedrock" },
      }),
    ).toBe(
      `Claude Code could not authenticate to Amazon Bedrock (credentials missing or expired). ${CLAUDE_BEDROCK_CREDENTIAL_REMEDIATION}`,
    )
  })

  it("uses first-party Claude remediation when that provider is reported", () => {
    expect(
      formatTerminalAuthErrorMessage({
        backendLabel: "Claude Code",
        provider: { id: "firstParty", label: "First-party" },
      }),
    ).toBe(
      `Claude Code could not authenticate (credentials missing or expired). ${CLAUDE_FIRST_PARTY_AUTH_REMEDIATION}`,
    )
  })

  it("names the backend without inventing a provider", () => {
    expect(
      formatTerminalAuthErrorMessage({
        backendLabel: "OpenCode",
      }),
    ).toBe(
      "OpenCode could not authenticate (credentials missing or expired). Refresh credentials for the harness process, then Recheck Agent Backend.",
    )
  })

  it("does not present aws sso login as the remedy", () => {
    const message = formatTerminalAuthErrorMessage({
      backendLabel: "Claude Code",
      provider: { id: "bedrock", label: "Amazon Bedrock" },
    })
    expect(message.toLowerCase()).not.toContain("aws sso login")
  })
})
