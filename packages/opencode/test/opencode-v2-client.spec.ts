import {
  type OpencodeServiceEndpoint,
  connectOpencodeV2,
} from "../src/lib/opencode-v2-client.js"
import { OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC } from "../src/lib/opencode-v2-compatibility.js"
import { describe, expect, test } from "bun:test"

const discoveredServer = {
  url: "http://127.0.0.1:1",
  auth: {
    type: "basic" as const,
    username: "opencode",
    password: "secret",
  },
} satisfies OpencodeServiceEndpoint

const expectNoVersionDiagnostic = (value: unknown): void => {
  const text = JSON.stringify(value)
  expect(text).not.toContain("supported V2")
  expect(text).not.toContain("V1 fallback")
}

describe("OpenCode V2 connection", () => {
  test("a discovered server is ready without a version filter", async () => {
    let calls = 0
    const result = await connectOpencodeV2({
      requestTimeoutMs: 20,
      discover: async (options) => {
        expect(options?.version).toBeUndefined()
        calls += 1
        return discoveredServer
      },
      readRegistration: () => {
        throw new Error("registration must not replace a discovered server")
      },
    })
    expect(calls).toBe(1)
    expect(result.kind).toBe("ready")
    expectNoVersionDiagnostic(result)
  })

  test("temporary startup unavailability is not an unsupported-version rejection", async () => {
    const result = await connectOpencodeV2({
      discover: async () => {
        throw new Error("connect ECONNREFUSED")
      },
      readRegistration: () => discoveredServer,
    })
    expect(result.kind).toBe("unavailable")
    if (result.kind !== "unavailable") return
    expect(result.persistence).toBe("transient")
    expect(result.diagnostic).not.toContain("supported V2")
    expect(result.diagnostic).not.toContain("V1 fallback")
    expect(result.diagnostic).not.toContain("compatibility failure")
  })

  test("an explicit server is ready without a version preflight", async () => {
    const result = await connectOpencodeV2({
      server: {
        baseUrl: "http://127.0.0.1:1",
        headers: { authorization: "Basic secret" },
      },
      requestTimeoutMs: 20,
      discover: async () => {
        throw new Error("discover must not run for an explicit server")
      },
    })
    expect(result.kind).toBe("ready")
    expectNoVersionDiagnostic(result)
  })

  test("a registered server that discovery has not marked ready is not a compatibility failure", async () => {
    let calls = 0
    const result = await connectOpencodeV2({
      requestTimeoutMs: 20,
      discover: async (options) => {
        expect(options?.version).toBeUndefined()
        calls += 1
        return undefined
      },
      readRegistration: () => discoveredServer,
    })
    expect(calls).toBe(1)
    expect(result.kind).toBe("ready")
    expectNoVersionDiagnostic(result)
  })

  test("a missing service stays a transient startup failure", async () => {
    const result = await connectOpencodeV2({
      discover: async () => undefined,
      readRegistration: () => null,
    })
    expect(result).toEqual({
      kind: "unavailable",
      persistence: "transient",
      diagnostic: OPENCODE_V2_SERVICE_MISSING_DIAGNOSTIC,
    })
    expectNoVersionDiagnostic(result)
  })
})
