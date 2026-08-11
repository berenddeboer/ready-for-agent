import {
  ALL_INTERFACES_HOST,
  DEFAULT_LISTEN_HOST,
  canonicalizeHostname,
  expandBareHostFlag,
  formatListenUrl,
  isRequestHostAdmitted,
  isWildcardBindHost,
  normalizeHostToken,
  parseHostFlagFromArgv,
  resolveBrowserOpenUrl,
  resolveListenHost,
} from "../src/server/listen-host.ts"
import { describe, expect, test } from "bun:test"

describe("normalizeHostToken", () => {
  test("maps Vite true / empty / 0.0.0.0 to all interfaces", () => {
    expect(normalizeHostToken("")).toBe(ALL_INTERFACES_HOST)
    expect(normalizeHostToken("true")).toBe(ALL_INTERFACES_HOST)
    expect(normalizeHostToken("  true  ")).toBe(ALL_INTERFACES_HOST)
    expect(normalizeHostToken("0.0.0.0")).toBe(ALL_INTERFACES_HOST)
  })

  test("maps false to loopback default", () => {
    expect(normalizeHostToken("false")).toBe(DEFAULT_LISTEN_HOST)
  })

  test("preserves IPv6 wildcards and concrete addresses", () => {
    expect(normalizeHostToken("::")).toBe("::")
    expect(normalizeHostToken("[::]")).toBe("::")
    expect(normalizeHostToken("192.168.1.10")).toBe("192.168.1.10")
    expect(normalizeHostToken("  10.0.0.5  ")).toBe("10.0.0.5")
  })
})

describe("resolveListenHost", () => {
  test("defaults to loopback when flag and env are absent", () => {
    expect(resolveListenHost({})).toBe(DEFAULT_LISTEN_HOST)
    expect(resolveListenHost({ env: undefined })).toBe(DEFAULT_LISTEN_HOST)
    expect(resolveListenHost({ env: "" })).toBe(DEFAULT_LISTEN_HOST)
    expect(resolveListenHost({ env: "   " })).toBe(DEFAULT_LISTEN_HOST)
  })

  test("uses HOST env when flag is omitted", () => {
    expect(resolveListenHost({ env: "true" })).toBe(ALL_INTERFACES_HOST)
    expect(resolveListenHost({ env: "0.0.0.0" })).toBe(ALL_INTERFACES_HOST)
    expect(resolveListenHost({ env: "192.168.1.10" })).toBe("192.168.1.10")
  })

  test("flag wins over HOST env", () => {
    expect(resolveListenHost({ flag: "10.0.0.1", env: "0.0.0.0" })).toBe(
      "10.0.0.1",
    )
    expect(resolveListenHost({ flag: "true", env: "192.168.1.10" })).toBe(
      ALL_INTERFACES_HOST,
    )
    expect(resolveListenHost({ flag: "127.0.0.1", env: "0.0.0.0" })).toBe(
      "127.0.0.1",
    )
  })
})

describe("isWildcardBindHost / isRequestHostAdmitted", () => {
  test("detects IPv4 and IPv6 wildcards", () => {
    expect(isWildcardBindHost("0.0.0.0")).toBe(true)
    expect(isWildcardBindHost("::")).toBe(true)
    expect(isWildcardBindHost("[::]")).toBe(true)
    expect(isWildcardBindHost("127.0.0.1")).toBe(false)
    expect(isWildcardBindHost("192.168.1.10")).toBe(false)
  })

  test("wildcard bind admits any request Host", () => {
    expect(
      isRequestHostAdmitted({
        requestHostname: "192.168.1.10",
        bindHostname: "0.0.0.0",
      }),
    ).toBe(true)
    expect(
      isRequestHostAdmitted({
        requestHostname: "my-laptop.local",
        bindHostname: "::",
      }),
    ).toBe(true)
    expect(
      isRequestHostAdmitted({
        requestHostname: "127.0.0.1",
        bindHostname: "0.0.0.0",
      }),
    ).toBe(true)
  })

  test("concrete bind requires matching Host after IPv6 bracket canonicalization", () => {
    expect(canonicalizeHostname("[::1]")).toBe("::1")
    expect(canonicalizeHostname("::1")).toBe("::1")
    expect(canonicalizeHostname("[2001:DB8::1]")).toBe("2001:db8::1")

    expect(
      isRequestHostAdmitted({
        requestHostname: "127.0.0.1",
        bindHostname: "127.0.0.1",
      }),
    ).toBe(true)
    expect(
      isRequestHostAdmitted({
        requestHostname: "192.168.1.10",
        bindHostname: "192.168.1.10",
      }),
    ).toBe(true)
    // Bun may report request hostname with brackets; bind host is unbracketed.
    expect(
      isRequestHostAdmitted({
        requestHostname: "[2001:db8::1]",
        bindHostname: "2001:db8::1",
      }),
    ).toBe(true)
    expect(
      isRequestHostAdmitted({
        requestHostname: "2001:db8::1",
        bindHostname: "[2001:db8::1]",
      }),
    ).toBe(true)
    expect(
      isRequestHostAdmitted({
        requestHostname: "[::1]",
        bindHostname: "::1",
      }),
    ).toBe(true)
    expect(
      isRequestHostAdmitted({
        requestHostname: "192.168.1.99",
        bindHostname: "192.168.1.10",
      }),
    ).toBe(false)
    expect(
      isRequestHostAdmitted({
        requestHostname: "evil.example",
        bindHostname: "127.0.0.1",
      }),
    ).toBe(false)
    expect(
      isRequestHostAdmitted({
        requestHostname: "[2001:db8::2]",
        bindHostname: "2001:db8::1",
      }),
    ).toBe(false)
  })
})

describe("listen vs browser-open URLs", () => {
  test("listen URL reflects bind host with IPv6 brackets", () => {
    expect(formatListenUrl("0.0.0.0", 6056)).toBe("http://0.0.0.0:6056/")
    expect(formatListenUrl("192.168.1.10", 7000)).toBe(
      "http://192.168.1.10:7000/",
    )
    expect(formatListenUrl("::", 6056)).toBe("http://[::]:6056/")
    expect(formatListenUrl("[::]", 6056)).toBe("http://[::]:6056/")
    expect(formatListenUrl("2001:db8::1", 7000)).toBe(
      "http://[2001:db8::1]:7000/",
    )
    // Must parse as URLs (unbracketed IPv6 authorities are invalid).
    const wildcard = new URL(formatListenUrl("::", 6056))
    const concrete = new URL(formatListenUrl("2001:db8::1", 7000))
    expect(wildcard.href).toBe("http://[::]:6056/")
    expect(concrete.href).toBe("http://[2001:db8::1]:7000/")
    expect(wildcard.port).toBe("6056")
    expect(concrete.port).toBe("7000")
  })

  test("browser open uses loopback for wildcards and the bind host otherwise", () => {
    expect(resolveBrowserOpenUrl(6056)).toBe("http://127.0.0.1:6056/")
    expect(resolveBrowserOpenUrl(6056, "0.0.0.0")).toBe(
      "http://127.0.0.1:6056/",
    )
    expect(resolveBrowserOpenUrl(6056, "::")).toBe("http://127.0.0.1:6056/")
    expect(resolveBrowserOpenUrl(7000, "192.168.1.10")).toBe(
      "http://192.168.1.10:7000/",
    )
    expect(resolveBrowserOpenUrl(7000, "2001:db8::1")).toBe(
      "http://[2001:db8::1]:7000/",
    )
  })
})

describe("expandBareHostFlag / parseHostFlagFromArgv", () => {
  test("expands bare --host for Effect string flags", () => {
    expect(expandBareHostFlag(["start", "--host"])).toEqual([
      "start",
      "--host",
      ALL_INTERFACES_HOST,
    ])
    expect(expandBareHostFlag(["--host", "--no-open"])).toEqual([
      "--host",
      ALL_INTERFACES_HOST,
      "--no-open",
    ])
    expect(expandBareHostFlag(["--host="])).toEqual([
      "--host",
      ALL_INTERFACES_HOST,
    ])
  })

  test("preserves explicit --host values", () => {
    expect(expandBareHostFlag(["start", "--host", "10.0.0.1"])).toEqual([
      "start",
      "--host",
      "10.0.0.1",
    ])
    expect(expandBareHostFlag(["--host=10.0.0.1", "start"])).toEqual([
      "--host",
      "10.0.0.1",
      "start",
    ])
  })

  test("parses host flag from production argv", () => {
    expect(parseHostFlagFromArgv(["bun", "server.ts"])).toBeUndefined()
    expect(parseHostFlagFromArgv(["bun", "server.ts", "--host"])).toBe(
      ALL_INTERFACES_HOST,
    )
    expect(
      parseHostFlagFromArgv(["bun", "server.ts", "--host", "10.0.0.1"]),
    ).toBe("10.0.0.1")
    expect(parseHostFlagFromArgv(["bun", "server.ts", "--host=::"])).toBe("::")
    expect(
      parseHostFlagFromArgv(["bun", "server.ts", "--no-open", "--host"]),
    ).toBe(ALL_INTERFACES_HOST)
  })
})
