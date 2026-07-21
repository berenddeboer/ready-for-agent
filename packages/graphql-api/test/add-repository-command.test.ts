import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import {
  addRepositoryCommand,
  commandExistsOnPath,
  isOperatorBinaryOnPath,
  resolveAddRepositoryCommand,
} from "../src/lib/add-repository-command.js"
import { afterEach, describe, expect, test } from "bun:test"

const temporaryDirectories: Array<string> = []

const executableAt = (directory: string, command: string): void => {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, command), "#!/bin/sh\n", { mode: 0o755 })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("commandExistsOnPath", () => {
  test("ignores a binary available only through an npx node_modules bin", () => {
    const root = mkdtempSync(join(tmpdir(), "ready-for-agent-path-"))
    temporaryDirectories.push(root)
    const npxBin = join(
      root,
      ".npm",
      "_npx",
      "cache-key",
      "node_modules",
      ".bin",
    )
    executableAt(npxBin, "ready-for-agent")

    expect(commandExistsOnPath("ready-for-agent", npxBin)).toBe(false)
  })

  test("still finds a binary on a durable PATH entry", () => {
    const root = mkdtempSync(join(tmpdir(), "ready-for-agent-path-"))
    temporaryDirectories.push(root)
    const packageBin = join(root, "node_modules", ".bin")
    const durableBin = join(root, ".local", "bin")
    executableAt(packageBin, "ready-for-agent")
    executableAt(durableBin, "ready-for-agent")

    expect(
      commandExistsOnPath(
        "ready-for-agent",
        [packageBin, durableBin].join(delimiter),
      ),
    ).toBe(true)
  })
})

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
