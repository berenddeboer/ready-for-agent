import {
  isLocalFilePath,
  normalizeDatabasePath,
  resolveProductDataDir,
  resolveProductDatabasePath,
  toTursoDatabasePath,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("Turso database path helpers", () => {
  it("normalizes bare paths as file URLs", () => {
    expect(normalizeDatabasePath("./data/app.db")).toBe("file://./data/app.db")
  })

  it("preserves explicit protocols", () => {
    expect(normalizeDatabasePath("file:./data/app.db")).toBe(
      "file:./data/app.db",
    )
  })

  it("detects local file paths", () => {
    expect(isLocalFilePath("./data/app.db")).toBe(true)
    expect(isLocalFilePath("file:./data/app.db")).toBe(true)
    expect(isLocalFilePath("libsql://example.turso.io")).toBe(false)
  })

  it("converts file URLs to absolute Turso SDK paths", () => {
    expect(toTursoDatabasePath("file://./data/app.db")).toBe(
      `${process.cwd()}/data/app.db`,
    )
    expect(toTursoDatabasePath("file:./data/app.db")).toBe(
      `${process.cwd()}/data/app.db`,
    )
    expect(toTursoDatabasePath("/abs/data/app.db")).toBe("/abs/data/app.db")
    expect(toTursoDatabasePath(":memory:")).toBe(":memory:")
    expect(toTursoDatabasePath("file::memory:")).toBe(":memory:")
  })

  it("resolves product data dir for Linux and macOS", () => {
    expect(
      resolveProductDataDir({
        env: {},
        platform: "linux",
        home: "/home/op",
      }),
    ).toBe("/home/op/.local/share/ready-for-agent")
    expect(
      resolveProductDataDir({
        env: { XDG_DATA_HOME: "/var/data" },
        platform: "linux",
        home: "/home/op",
      }),
    ).toBe("/var/data/ready-for-agent")
    expect(
      resolveProductDataDir({
        env: {},
        platform: "darwin",
        home: "/Users/op",
      }),
    ).toBe("/Users/op/Library/Application Support/ready-for-agent")
  })

  it("resolves product database path under the data dir", () => {
    expect(
      resolveProductDatabasePath({
        env: {},
        platform: "linux",
        home: "/home/op",
      }),
    ).toBe("/home/op/.local/share/ready-for-agent/ready-for-agent.db")
  })
})
