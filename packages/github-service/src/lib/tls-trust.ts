/**
 * TLS trust failures for forge HTTPS (corporate MITM, missing private CA, etc.).
 *
 * Bun/Node `fetch` does not read the OS trust store. Operators typically see
 * `git`/`gh`/`curl` succeed while Ready for Agent fails with OpenSSL codes such
 * as `SELF_SIGNED_CERT_IN_CHAIN`. These conditions are permanent for the process
 * lifetime and must not be retried as transient transport errors.
 */

/** OpenSSL / Node TLS codes that indicate a non-retryable certificate trust failure. */
export const TLS_TRUST_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_CRL",
  "CERT_SIGNATURE_FAILURE",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "HOSTNAME_MISMATCH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
])

const GITHUB_API_HOST = "api.github.com"

/**
 * Walk a nested `cause` chain (TypeError fetch failed → OpenSSL error) and
 * return the first recognized TLS trust code, if any.
 */
const readUnknownField = (value: object, key: string): unknown =>
  key in value ? Reflect.get(value, key) : undefined

export const findTlsTrustCode = (cause: unknown): string | undefined => {
  const seen = new Set<unknown>()
  let current: unknown = cause
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (typeof current === "object") {
      const code = readUnknownField(current, "code")
      if (typeof code === "string" && TLS_TRUST_ERROR_CODES.has(code)) {
        return code
      }
      current = readUnknownField(current, "cause")
      continue
    }
    break
  }
  return undefined
}

export const isTlsTrustFailure = (cause: unknown): boolean =>
  findTlsTrustCode(cause) !== undefined

/** Host used by the live GitHub GraphQL/REST client. */
export const githubApiHost = (): string => GITHUB_API_HOST

export type TlsTrustRemediationInput = {
  readonly host: string
  readonly code?: string
  readonly issuer?: string | null
  /** Optional operation-level prefix (e.g. "Failed to list Ready-labeled Issues…"). */
  readonly operationMessage?: string
}

/**
 * Operator-facing copy that names corporate TLS inspection and the
 * `NODE_EXTRA_CA_CERTS` remedy. Bun honours that env var in the compiled binary.
 */
export const formatTlsTrustRemediation = (
  input: TlsTrustRemediationInput,
): string => {
  const host = input.host.trim() === "" ? GITHUB_API_HOST : input.host.trim()
  const issuer =
    typeof input.issuer === "string" && input.issuer.trim() !== ""
      ? input.issuer.trim()
      : null
  const issuerLine =
    issuer === null
      ? "The certificate chain is signed by a private or corporate CA rather than a public CA, which usually means a TLS-inspection proxy (Netskope, Zscaler, Palo Alto, mitmproxy, etc.)."
      : `The certificate chain is signed by "${issuer}" rather than a public CA, which usually means a corporate TLS-inspection proxy.`

  const lines = [
    `Cannot establish a trusted TLS connection to ${host}.`,
    issuerLine,
    "git/gh/curl trust it via the OS trust store, but Ready for Agent does not read that store.",
    "Export the root CA and point NODE_EXTRA_CA_CERTS at it:",
    "  # macOS (Netskope example — adjust -c to match your proxy CA common name):",
    "  security find-certificate -a -c certadmin -p /Library/Keychains/System.keychain > ~/.config/corp-ca.pem",
    "  export NODE_EXTRA_CA_CERTS=~/.config/corp-ca.pem",
    "  # Linux: export NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem",
  ]
  if (input.code !== undefined && input.code.trim() !== "") {
    lines.splice(1, 0, `TLS error code: ${input.code.trim()}.`)
  }
  const body = lines.join("\n")
  if (
    input.operationMessage !== undefined &&
    input.operationMessage.trim() !== ""
  ) {
    return `${input.operationMessage.trim()}\n${body}`
  }
  return body
}
