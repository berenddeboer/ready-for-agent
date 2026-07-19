import {
  addRepositoryCommand,
  isOperatorBinaryOnPath,
  resolveAddRepositoryCommand,
} from "../src/lib/add-repository-command.js"
import { describe, expect, test } from "bun:test"

describe("addRepositoryCommand", () => {
  test("suggests bare binary when on PATH", () => {
    expect(addRepositoryCommand({ operatorBinaryOnPath: true })).toBe(
      "ready-for-agent add /path/to/local/repo",
    )
  })

  test("prepends npx when not on PATH", () => {
    expect(addRepositoryCommand({ operatorBinaryOnPath: false })).toBe(
      "npx ready-for-agent add /path/to/local/repo",
    )
  })
})

describe("isOperatorBinaryOnPath", () => {
  test("is true when commandExists finds ready-for-agent", () => {
    expect(
      isOperatorBinaryOnPath((command) => command === "ready-for-agent"),
    ).toBe(true)
  })

  test("is false when commandExists does not find ready-for-agent", () => {
    expect(isOperatorBinaryOnPath(() => false)).toBe(false)
  })
})

describe("resolveAddRepositoryCommand", () => {
  test("uses PATH check to choose suggestion", () => {
    expect(resolveAddRepositoryCommand(() => true)).toBe(
      "ready-for-agent add /path/to/local/repo",
    )
    expect(resolveAddRepositoryCommand(() => false)).toBe(
      "npx ready-for-agent add /path/to/local/repo",
    )
  })
})
