import {
  makeOpenCodeServerBaseResolver,
  parseOpenCodeServiceStatus,
  resolveOpenCodeServerBase,
} from "../src/lib/resolve-server-base.js"
import { describe, expect, it } from "bun:test"

describe("parseOpenCodeServiceStatus", () => {
  it("reads the address printed by opencode service status", () => {
    expect(parseOpenCodeServiceStatus("http://127.0.0.1:49374\n")).toBe(
      "http://127.0.0.1:49374",
    )
    expect(parseOpenCodeServiceStatus("https://opencode.example:8443/\n")).toBe(
      "https://opencode.example:8443",
    )
  })

  it("ignores non-URL noise and does not invent a localhost port", () => {
    expect(parseOpenCodeServiceStatus("service is not running\n")).toBeNull()
    expect(parseOpenCodeServiceStatus("")).toBeNull()
  })
})

describe("resolveOpenCodeServerBase", () => {
  it("uses an explicitly configured server and does not call service status", async () => {
    let calls = 0
    const resolved = await resolveOpenCodeServerBase({
      explicitServerBase: "http://10.0.0.8:4096/",
      serviceStatus: async () => {
        calls += 1
        return "http://127.0.0.1:49374\n"
      },
    })
    expect(resolved).toBe("http://10.0.0.8:4096")
    expect(calls).toBe(0)
  })

  it("does not fall through when the explicit server is not browser-usable", async () => {
    let calls = 0
    const resolved = await resolveOpenCodeServerBase({
      explicitServerBase: "http://user:secret@10.0.0.8:4096",
      serviceStatus: async () => {
        calls += 1
        return "http://127.0.0.1:49374\n"
      },
    })
    expect(resolved).toBeNull()
    expect(calls).toBe(0)
  })

  it("uses service status for the default shared local service", async () => {
    const resolved = await resolveOpenCodeServerBase({
      serviceStatus: async () => "http://192.168.1.20:45278\n",
    })
    expect(resolved).toBe("http://192.168.1.20:45278")
  })

  it("returns null when service status fails", async () => {
    const resolved = await resolveOpenCodeServerBase({
      serviceStatus: async () => {
        throw new Error("opencode not installed")
      },
    })
    expect(resolved).toBeNull()
  })
})

describe("makeOpenCodeServerBaseResolver", () => {
  it("reuses a status result within the ttl", async () => {
    let calls = 0
    let now = 1_000
    const resolve = makeOpenCodeServerBaseResolver({
      now: () => now,
      ttlMs: 5_000,
      serviceStatus: async () => {
        calls += 1
        return "http://127.0.0.1:49374\n"
      },
    })
    expect(await resolve()).toBe("http://127.0.0.1:49374")
    now = 2_000
    expect(await resolve()).toBe("http://127.0.0.1:49374")
    expect(calls).toBe(1)
    now = 7_000
    expect(await resolve()).toBe("http://127.0.0.1:49374")
    expect(calls).toBe(2)
  })
})
