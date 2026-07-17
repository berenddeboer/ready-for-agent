import {
  resolveDefaultDatabasePath,
  resolveProductDataDir,
} from "./product-data-dir.ts"
import { describe, expect, test } from "bun:test"

describe("product data dir", () => {
  test("Linux defaults to ~/.local/share/ready-for-agent", () => {
    expect(
      resolveProductDataDir({
        env: {},
        platform: "linux",
        home: "/home/op",
      }),
    ).toBe("/home/op/.local/share/ready-for-agent")
  })

  test("Linux honors XDG_DATA_HOME", () => {
    expect(
      resolveProductDataDir({
        env: { XDG_DATA_HOME: "/var/data" },
        platform: "linux",
        home: "/home/op",
      }),
    ).toBe("/var/data/ready-for-agent")
  })

  test("macOS uses Application Support", () => {
    expect(
      resolveProductDataDir({
        env: { XDG_DATA_HOME: "/ignored" },
        platform: "darwin",
        home: "/Users/op",
      }),
    ).toBe("/Users/op/Library/Application Support/ready-for-agent")
  })

  test("default database path is under the product data dir", () => {
    expect(
      resolveDefaultDatabasePath({
        env: {},
        platform: "linux",
        home: "/home/op",
      }),
    ).toBe("/home/op/.local/share/ready-for-agent/ready-for-agent.db")
  })

  test("SQLITE_DATABASE_PATH overrides the product default", () => {
    expect(
      resolveDefaultDatabasePath({
        env: { SQLITE_DATABASE_PATH: "/custom/app.db" },
        platform: "linux",
        home: "/home/op",
      }),
    ).toBe("/custom/app.db")
  })

  test("blank SQLITE_DATABASE_PATH falls back to product default", () => {
    expect(
      resolveDefaultDatabasePath({
        env: { SQLITE_DATABASE_PATH: "  " },
        platform: "linux",
        home: "/home/op",
      }),
    ).toBe("/home/op/.local/share/ready-for-agent/ready-for-agent.db")
  })
})
