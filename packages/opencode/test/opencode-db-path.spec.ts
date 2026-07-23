import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  queryOpencodeDbPathViaCli,
  resolveOpencodeDataDir,
  resolveOpencodeDbPath,
  resolveOpencodeDbPathFromRules,
} from "../src/lib/opencode-db-path.js"
import { describe, expect, test } from "bun:test"

describe("resolveOpencodeDataDir", () => {
  test("uses XDG_DATA_HOME when set", () => {
    expect(
      resolveOpencodeDataDir({
        env: { XDG_DATA_HOME: "/var/data" },
        home: "/home/op",
      }),
    ).toBe("/var/data/opencode")
  })

  test("defaults to ~/.local/share/opencode (xdg-basedir on all platforms)", () => {
    expect(
      resolveOpencodeDataDir({
        env: {},
        home: "/Users/op",
      }),
    ).toBe("/Users/op/.local/share/opencode")
  })

  test("does not use macOS Application Support", () => {
    expect(
      resolveOpencodeDataDir({
        env: {},
        home: "/Users/op",
      }),
    ).not.toContain("Application Support")
  })
})

describe("resolveOpencodeDbPathFromRules", () => {
  test("defaults to opencode.db for latest channel", () => {
    expect(
      resolveOpencodeDbPathFromRules({
        env: {},
        home: "/home/op",
      }),
    ).toBe("/home/op/.local/share/opencode/opencode.db")
  })

  test("OPENCODE_DB absolute path wins", () => {
    expect(
      resolveOpencodeDbPathFromRules({
        env: { OPENCODE_DB: "/tmp/custom.db" },
        home: "/home/op",
      }),
    ).toBe("/tmp/custom.db")
  })

  test("OPENCODE_DB relative path joins data dir", () => {
    expect(
      resolveOpencodeDbPathFromRules({
        env: { OPENCODE_DB: "foo.db" },
        home: "/home/op",
      }),
    ).toBe("/home/op/.local/share/opencode/foo.db")
  })

  test("non-release channel uses channel-suffixed db name", () => {
    expect(
      resolveOpencodeDbPathFromRules({
        env: {},
        channel: "dev",
        home: "/home/op",
      }),
    ).toBe("/home/op/.local/share/opencode/opencode-dev.db")
  })

  test("OPENCODE_DISABLE_CHANNEL_DB forces opencode.db", () => {
    expect(
      resolveOpencodeDbPathFromRules({
        env: {
          OPENCODE_DISABLE_CHANNEL_DB: "true",
        },
        channel: "dev",
        home: "/home/op",
      }),
    ).toBe("/home/op/.local/share/opencode/opencode.db")
  })
})

describe("queryOpencodeDbPathViaCli", () => {
  test("returns null when binary is missing", () => {
    expect(
      queryOpencodeDbPathViaCli("opencode-binary-does-not-exist-xyz"),
    ).toBe(null)
  })

  test("returns null when the CLI exceeds the timeout", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-db-path-"))
    const hang = join(dir, "hang-opencode")
    try {
      writeFileSync(hang, "#!/bin/sh\nsleep 30\n")
      chmodSync(hang, 0o755)
      const started = Date.now()
      expect(queryOpencodeDbPathViaCli(hang, process.env, 80)).toBe(null)
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns path when opencode is on PATH", () => {
    const path = queryOpencodeDbPathViaCli("opencode")
    if (path === null) {
      // OpenCode may be absent in some CI images; production then stays UNAVAILABLE.
      return
    }
    expect(path.length).toBeGreaterThan(0)
    expect(path).toMatch(/opencode/)
  })
})

describe("resolveOpencodeDbPath", () => {
  test("does not guess latest when CLI fails and channel is unknown", () => {
    expect(
      resolveOpencodeDbPath({
        binary: "opencode-binary-does-not-exist-xyz",
        env: {},
        home: "/home/op",
      }),
    ).toBeNull()
  })

  test("falls back to rules when OPENCODE_DB is set and CLI fails", () => {
    expect(
      resolveOpencodeDbPath({
        binary: "opencode-binary-does-not-exist-xyz",
        env: { OPENCODE_DB: "/tmp/custom.db" },
        home: "/home/op",
      }),
    ).toBe("/tmp/custom.db")
  })

  test("falls back to rules when channel is explicit and CLI fails", () => {
    expect(
      resolveOpencodeDbPath({
        binary: "opencode-binary-does-not-exist-xyz",
        channel: "dev",
        env: {},
        home: "/home/op",
      }),
    ).toBe("/home/op/.local/share/opencode/opencode-dev.db")
  })
})
