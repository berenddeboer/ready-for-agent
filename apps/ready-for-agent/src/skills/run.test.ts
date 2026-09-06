import { isSkillsInvocation } from "./run.ts"
import { describe, expect, test } from "bun:test"

describe("skills fast-path detection", () => {
  test("treats skills as the first command", () => {
    expect(isSkillsInvocation(["skills"])).toBe(true)
    expect(isSkillsInvocation(["skills", "list", "--json"])).toBe(true)
    expect(
      isSkillsInvocation(["--log-level", "debug", "skills", "get", "core"]),
    ).toBe(true)
  })

  test("does not steal root start flags from the full CLI", () => {
    expect(isSkillsInvocation(["--host", "127.0.0.1", "skills", "list"])).toBe(
      false,
    )
    expect(isSkillsInvocation(["--host=0.0.0.0", "skills", "list"])).toBe(false)
    expect(isSkillsInvocation(["--no-open", "skills", "list"])).toBe(false)
  })

  test("leaves other commands and metadata switches on the full CLI", () => {
    expect(isSkillsInvocation(["status"])).toBe(false)
    expect(isSkillsInvocation(["--usage"])).toBe(false)
    expect(isSkillsInvocation(["--help"])).toBe(false)
    expect(isSkillsInvocation([])).toBe(false)
  })
})
