import { OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE } from "../src/lib/owned-server.js"
import {
  OPENCODE_SESSION_HANDOFF_REJECTED,
  OPENCODE_SESSION_HANDOFF_SHARED_MISSING,
  mintOpenCodeSessionHandoff,
  openCodeBasicAuthFromPassword,
  openCodeConnectUrl,
  openCodeSessionLaunch,
  parseOpenCodePairingCode,
  redactOpenCodeHandoffSecrets,
  requestOpenCodePairingCode,
  selectOpenCodeHandoffServer,
} from "../src/lib/session-handoff.js"
import { describe, expect, it } from "bun:test"

const SERVER = "http://127.0.0.1:49374"
const SESSION = "ses_ead6dfcf7ffejTs5Mqlo1UD64v"
const CODE = "Ejv80WeudfkqaqHV2ZupcQ"
const PASSWORD = "owned-server-password"
const CAPABILITY = "http://127.0.0.1:9/capability/secret"

describe("selectOpenCodeHandoffServer", () => {
  it("uses the owned server and ignores shared discovery", () => {
    const selected = selectOpenCodeHandoffServer({
      connection: {
        kind: "dedicated",
        baseUrl: SERVER,
        headers: { authorization: "Basic eHh4" },
      },
      discovered: { baseUrl: "http://127.0.0.1:9" },
    })
    expect(selected).toEqual({
      kind: "server",
      baseUrl: SERVER,
      headers: { authorization: "Basic eHh4" },
      mode: "owned",
    })
  })

  it("does not fall back when the owned server is down", () => {
    const selected = selectOpenCodeHandoffServer({
      connection: {
        kind: "dedicated",
        baseUrl: SERVER,
        headers: { authorization: "Basic eHh4" },
        unavailable: OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE,
      },
      discovered: { baseUrl: "http://127.0.0.1:9" },
    })
    expect(selected).toEqual({
      kind: "unavailable",
      message: OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE,
    })
  })

  it("uses an explicit server instead of discovery", () => {
    const selected = selectOpenCodeHandoffServer({
      connection: {
        kind: "explicit",
        baseUrl: `${SERVER}/`,
        headers: { authorization: "Basic explicit" },
      },
      discovered: { baseUrl: "http://127.0.0.1:9" },
    })
    expect(selected).toMatchObject({
      kind: "server",
      baseUrl: SERVER,
      mode: "explicit",
    })
  })

  it("uses shared discovery only for the default connection", () => {
    expect(
      selectOpenCodeHandoffServer({
        connection: { kind: "default" },
        discovered: {
          baseUrl: SERVER,
          headers: { authorization: "Basic shared" },
        },
      }),
    ).toMatchObject({ kind: "server", baseUrl: SERVER, mode: "shared" })
    expect(
      selectOpenCodeHandoffServer({
        connection: { kind: "default" },
        discovered: null,
      }),
    ).toEqual({
      kind: "unavailable",
      message: OPENCODE_SESSION_HANDOFF_SHARED_MISSING,
    })
  })
})

describe("openCode session launch URLs", () => {
  it("builds a credential-free connect URL and the matching session URL", () => {
    expect(openCodeConnectUrl({ serverBase: SERVER, code: CODE })).toBe(
      `${SERVER}/auth/connect/${CODE}`,
    )
    expect(
      openCodeSessionLaunch({
        serverBase: SERVER,
        sessionId: SESSION,
        code: CODE,
      }),
    ).toEqual({
      connectUrl: `${SERVER}/auth/connect/${CODE}`,
      sessionUrl: `${SERVER}/server/aHR0cDovLzEyNy4wLjAuMTo0OTM3NA/session/${SESSION}`,
    })
  })

  it("rejects credentials and pairing codes that are not a single path segment", () => {
    expect(
      openCodeConnectUrl({
        serverBase: "http://opencode:secret@127.0.0.1:1",
        code: CODE,
      }),
    ).toBeNull()
    expect(
      openCodeConnectUrl({ serverBase: SERVER, code: "../admin" }),
    ).toBeNull()
    expect(parseOpenCodePairingCode({ code: CODE, expires_in: 300 })).toEqual({
      code: CODE,
      expiresIn: 300,
    })
    expect(
      parseOpenCodePairingCode({ code: "short", expires_in: 300 }),
    ).toBeNull()
  })
})

describe("mintOpenCodeSessionHandoff", () => {
  it("mints only against the selected server", async () => {
    const calls: string[] = []
    const result = await mintOpenCodeSessionHandoff({
      server: {
        kind: "server",
        baseUrl: SERVER,
        headers: { authorization: "Basic eHh4" },
        mode: "owned",
      },
      sessionId: SESSION,
      pair: async (input) => {
        calls.push(input.baseUrl)
        expect(input.headers).toEqual({ authorization: "Basic eHh4" })
        return { kind: "code", code: CODE, expiresIn: 300 }
      },
    })
    expect(calls).toEqual([SERVER])
    expect(result.kind).toBe("ready")
    if (result.kind === "ready") {
      expect(result.launch.connectUrl).not.toContain(PASSWORD)
      expect(result.launch.sessionUrl).toContain(SESSION)
    }
  })

  it("does not mint when the server is unavailable", async () => {
    let paired = false
    const result = await mintOpenCodeSessionHandoff({
      server: {
        kind: "unavailable",
        message: OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE,
      },
      sessionId: SESSION,
      pair: async () => {
        paired = true
        return { kind: "code", code: CODE, expiresIn: 300 }
      },
    })
    expect(paired).toBe(false)
    expect(result).toEqual({
      kind: "unavailable",
      message: OWNED_OPENCODE_SERVER_UNAVAILABLE_MESSAGE,
    })
  })
})

describe("requestOpenCodePairingCode", () => {
  it("does not put the password or response body in a failure", async () => {
    const result = await requestOpenCodePairingCode({
      baseUrl: SERVER,
      headers: openCodeBasicAuthFromPassword(PASSWORD),
      secrets: [PASSWORD, CAPABILITY],
      fetchImpl: async () => {
        throw new Error(`pair failed password=${PASSWORD} url=${CAPABILITY}`)
      },
    })
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.message).not.toContain(PASSWORD)
      expect(result.message).not.toContain(CAPABILITY)
    }
  })

  it("treats a non-OK pair response as a bounded failure", async () => {
    const result = await requestOpenCodePairingCode({
      baseUrl: SERVER,
      fetchImpl: async () =>
        new Response(`password=${PASSWORD}`, { status: 401 }),
    })
    expect(result).toEqual({
      kind: "failed",
      message: OPENCODE_SESSION_HANDOFF_REJECTED,
    })
  })
})

describe("redactOpenCodeHandoffSecrets", () => {
  it("removes known secrets without inventing a log line", () => {
    expect(
      redactOpenCodeHandoffSecrets(`see ${PASSWORD} and ${CAPABILITY}`, [
        PASSWORD,
        CAPABILITY,
      ]),
    ).toBe("see [redacted] and [redacted]")
  })
})
