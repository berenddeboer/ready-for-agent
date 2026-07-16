import {
  isLocalFilePath,
  normalizeDatabasePath,
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
})
