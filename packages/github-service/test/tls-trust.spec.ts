import { describe, expect, it } from "vitest"
import {
  githubHelperTlsTrust,
  parseGitHubHelperControl,
  serializeGitHubHelperControl,
} from "../src/lib/github-helper-protocol.js"
import {
  findTlsTrustCode,
  formatTlsTrustRemediation,
  isTlsTrustFailure,
} from "../src/lib/tls-trust.js"

describe("TLS trust helpers", () => {
  it("finds nested OpenSSL codes under TypeError fetch failed", () => {
    const openssl = Object.assign(
      new Error("self-signed certificate in certificate chain"),
      { code: "SELF_SIGNED_CERT_IN_CHAIN" },
    )
    const fetchFailed = new TypeError("fetch failed", { cause: openssl })
    expect(findTlsTrustCode(fetchFailed)).toBe("SELF_SIGNED_CERT_IN_CHAIN")
    expect(isTlsTrustFailure(fetchFailed)).toBe(true)
  })

  it("returns undefined for ordinary transport failures", () => {
    expect(findTlsTrustCode(new TypeError("fetch failed"))).toBeUndefined()
    expect(
      findTlsTrustCode(
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      ),
    ).toBeUndefined()
    expect(isTlsTrustFailure(new Error("boom"))).toBe(false)
  })

  it("formats remediation that names NODE_EXTRA_CA_CERTS and the host", () => {
    const message = formatTlsTrustRemediation({
      host: "api.github.com",
      code: "SELF_SIGNED_CERT_IN_CHAIN",
      issuer: "Netskope Inc. / certadmin",
      operationMessage: "Failed to list Ready-labeled Issues for acme/widgets",
    })
    expect(message).toContain(
      "Failed to list Ready-labeled Issues for acme/widgets",
    )
    expect(message).toContain("api.github.com")
    expect(message).toContain("SELF_SIGNED_CERT_IN_CHAIN")
    expect(message).toContain("Netskope Inc. / certadmin")
    expect(message).toContain("NODE_EXTRA_CA_CERTS")
    expect(message).toContain("OS trust store")
  })

  it("round-trips non-secret TLS trust helper control records", () => {
    const serialized = serializeGitHubHelperControl(
      githubHelperTlsTrust({
        host: "api.github.com",
        code: "SELF_SIGNED_CERT_IN_CHAIN",
      }),
    )
    expect(parseGitHubHelperControl(serialized)).toEqual({
      version: 1,
      kind: "github-tls-trust",
      host: "api.github.com",
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    })
    expect(
      parseGitHubHelperControl(
        JSON.stringify({
          version: 1,
          kind: "github-tls-trust",
          host: "",
          code: "SELF_SIGNED_CERT_IN_CHAIN",
        }),
      ),
    ).toBeUndefined()
  })
})
