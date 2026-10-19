import {
  encodeOpenCodeServerKey,
  normalizeOpenCodeServerBase,
  openCodeSessionWebUrl,
} from "../src/lib/session-web-url.js"
import { describe, expect, it } from "bun:test"

const EXAMPLE_SERVER = "http://127.0.0.1:49374"
const EXAMPLE_SESSION = "ses_ead6dfcf7ffejTs5Mqlo1UD64v"
const EXAMPLE_URL =
  "http://127.0.0.1:49374/server/aHR0cDovLzEyNy4wLjAuMTo0OTM3NA/session/ses_ead6dfcf7ffejTs5Mqlo1UD64v"

describe("openCodeSessionWebUrl", () => {
  it("matches the supplied OpenCode V2 session URL exactly", () => {
    expect(
      openCodeSessionWebUrl({
        serverBase: EXAMPLE_SERVER,
        sessionId: EXAMPLE_SESSION,
      }),
    ).toBe(EXAMPLE_URL)
    expect(encodeOpenCodeServerKey(EXAMPLE_SERVER)).toBe(
      "aHR0cDovLzEyNy4wLjAuMTo0OTM3NA",
    )
  })

  it("normalizes trailing slashes before encoding the server key", () => {
    expect(
      openCodeSessionWebUrl({
        serverBase: "http://127.0.0.1:49374/",
        sessionId: EXAMPLE_SESSION,
      }),
    ).toBe(EXAMPLE_URL)
    expect(
      openCodeSessionWebUrl({
        serverBase: "http://127.0.0.1:49374///",
        sessionId: `  ${EXAMPLE_SESSION}  `,
      }),
    ).toBe(EXAMPLE_URL)
  })

  it("supports other server addresses and encodes the session id", () => {
    expect(
      openCodeSessionWebUrl({
        serverBase: "https://opencode.example:8443",
        sessionId: "ses_other",
      }),
    ).toBe(
      "https://opencode.example:8443/server/aHR0cHM6Ly9vcGVuY29kZS5leGFtcGxlOjg0NDM/session/ses_other",
    )
    expect(
      openCodeSessionWebUrl({
        serverBase: "http://10.0.0.8:4096",
        sessionId: "ses a/b",
      }),
    ).toBe(
      `http://10.0.0.8:4096/server/${encodeOpenCodeServerKey("http://10.0.0.8:4096")}/session/ses%20a%2Fb`,
    )
  })

  it("uses URL-safe base64 without padding", () => {
    const key = encodeOpenCodeServerKey("http://127.0.0.1:1")
    expect(key).not.toMatch(/[+/=]/)
    expect(key.endsWith("=")).toBe(false)
  })

  it("returns null when a browser URL cannot be built", () => {
    expect(
      openCodeSessionWebUrl({ serverBase: EXAMPLE_SERVER, sessionId: "  " }),
    ).toBeNull()
    expect(
      openCodeSessionWebUrl({ serverBase: "  ", sessionId: EXAMPLE_SESSION }),
    ).toBeNull()
    expect(
      openCodeSessionWebUrl({
        serverBase: "not a url",
        sessionId: EXAMPLE_SESSION,
      }),
    ).toBeNull()
    expect(normalizeOpenCodeServerBase("ftp://127.0.0.1:49374")).toBeNull()
    expect(
      normalizeOpenCodeServerBase("http://user:secret@127.0.0.1:49374"),
    ).toBeNull()
  })
})
