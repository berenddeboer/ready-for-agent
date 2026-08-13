import { systemError } from "effect/PlatformError"
import {
  findSpawnNotFoundCode,
  formatAgentCliNotFoundRemediation,
} from "../src/index.js"
import { describe, expect, it } from "bun:test"

describe("findSpawnNotFoundCode", () => {
  it("finds ENOENT on a nested PlatformError cause chain", () => {
    const enoent = Object.assign(
      new Error('Executable not found in $PATH: "claude"'),
      { code: "ENOENT" },
    )
    const spawnFailure = systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      description:
        "ChildProcess.spawn (claude -p --output-format stream-json ...)",
      cause: enoent,
    })

    expect(findSpawnNotFoundCode(spawnFailure)).toBe("ENOENT")
  })

  it("ignores FileSystem access ENOENT for a missing cwd", () => {
    const enoent = Object.assign(
      new Error("ENOENT: no such file or directory"),
      {
        code: "ENOENT",
        syscall: "access",
      },
    )
    const cwdAccess = systemError({
      _tag: "NotFound",
      module: "FileSystem",
      method: "access",
      pathOrDescriptor: "/missing/worktree",
      syscall: "access",
      cause: enoent,
    })

    expect(findSpawnNotFoundCode(cwdAccess)).toBeUndefined()
  })

  it("ignores EACCES and other spawn failures", () => {
    const eacces = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    })
    const spawnFailure = systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "spawn",
      cause: eacces,
    })

    expect(findSpawnNotFoundCode(spawnFailure)).toBeUndefined()
    expect(findSpawnNotFoundCode(new Error("boom"))).toBeUndefined()
    expect(
      findSpawnNotFoundCode(
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      ),
    ).toBeUndefined()
  })
})

describe("formatAgentCliNotFoundRemediation", () => {
  it("names the backend CLI and tells the operator to restart the Harness", () => {
    const message = formatAgentCliNotFoundRemediation({
      backendLabel: "Claude Code",
      binary: "claude",
    })

    expect(message).toContain(
      'Claude Code CLI "claude" was not found on the Harness PATH.',
    )
    expect(message).toContain("inherits the PATH of the shell that started it")
    expect(message).toContain("`command -v claude`")
    expect(message).toContain("restart the Harness")
  })
})
