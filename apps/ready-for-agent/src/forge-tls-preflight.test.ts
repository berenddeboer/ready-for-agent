import { checkForgeTlsTrust } from "./forge-tls-preflight.ts"
import { describe, expect, setDefaultTimeout, test } from "bun:test"

setDefaultTimeout(15_000)

describe("forge TLS preflight", () => {
  test("succeeds when every endpoint returns an HTTP response", async () => {
    let calls = 0
    const result = await checkForgeTlsTrust({
      endpoints: [
        { forge: "github", host: "api.github.com", path: "/" },
        { forge: "gitlab", host: "gitlab.example", path: "/api/v4/version" },
      ],
      fetchImpl: async () => {
        calls += 1
        return new Response("ok", { status: 200 })
      },
      readIssuer: async () => null,
    })
    expect(result).toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  test("fails loudly on TLS trust errors and includes remediation", async () => {
    const openssl = Object.assign(
      new Error("self-signed certificate in certificate chain"),
      { code: "SELF_SIGNED_CERT_IN_CHAIN" },
    )
    const result = await checkForgeTlsTrust({
      endpoints: [{ forge: "github", host: "api.github.com", path: "/" }],
      fetchImpl: async () => {
        throw new TypeError("fetch failed", { cause: openssl })
      },
      readIssuer: async () => "Netskope Inc. / certadmin",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.host).toBe("api.github.com")
    expect(result.code).toBe("SELF_SIGNED_CERT_IN_CHAIN")
    expect(result.issuer).toBe("Netskope Inc. / certadmin")
    expect(result.message).toContain("NODE_EXTRA_CA_CERTS")
    expect(result.message).toContain("Netskope Inc. / certadmin")
    expect(result.message).toContain("api.github.com")
  })

  test("ignores non-TLS transport failures so cold start is not blocked", async () => {
    const result = await checkForgeTlsTrust({
      endpoints: [{ forge: "github", host: "api.github.com", path: "/" }],
      fetchImpl: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        })
      },
      readIssuer: async () => {
        throw new Error("should not probe issuer for non-TLS failures")
      },
    })
    expect(result).toEqual({ ok: true })
  })
})
